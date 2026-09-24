// Procedural drawing for everything that sits on the land: trees, roads,
// rails, power lines and every building. All drawing happens in world
// pixels (tile * L), and every building stays inside its own lot, so the
// chunk cache can clip freely without seams.
//
// Buildings use the classic top-down-with-a-front view: the roof is shifted
// up by the building's height and the south facade shows underneath it.
import { BUILDINGS, POWER, RAIL, ROAD } from '../defs';
import { Rng, hash3, makeRng } from '../rng';
import type { Building, World } from '../world';
import { ZONE_MAP_COLORS, shade } from './color';

export interface Emitter {
  kind: 'smoke' | 'steam' | 'rotor' | 'beacon';
  /** World tile coordinates. */
  x: number;
  y: number;
  size: number;
}

export interface DC {
  ctx: CanvasRenderingContext2D;
  /** Pixels per tile. */
  L: number;
  world: World;
  emit?: (e: Emitter) => void;
}

const ROOFS = ['#B4533C', '#8C3B31', '#6E4C3A', '#56677A', '#3E5670', '#6D7E57', '#9A6B45', '#7A3E4F', '#A2482F'];
const WALLS = ['#F1E7D3', '#E7D8C2', '#DDE3E6', '#F2D8C6', '#E6E1D3', '#D9CDBB', '#EFE9DF'];
const APT_WALLS = ['#C98B6B', '#B7735A', '#D8CFC2', '#C9B8A6', '#E0D6C4', '#A9B2B8', '#BFA58A'];
const FLAT_ROOFS = ['#9B9A94', '#8C8C88', '#A7A39A', '#7F8488', '#96918A'];
const GLASS = ['#6F97B8', '#5A7FA3', '#86A9C2', '#4F6F8C', '#7FA0A8', '#6A8CA0'];
const AWNINGS = ['#D8453B', '#2E8B57', '#2C6FB7', '#E0A526', '#8E44AD', '#D35400'];
export const CAR_COLORS = ['#D64541', '#2E86DE', '#F5F6FA', '#353B48', '#F0C419', '#27AE60', '#8E8E93', '#E67E22', '#F5F6FA', '#1F2A36'];

const ASPHALT = '#565B5F';
const CURB = '#BBB5A8';
const LANE = '#E6C35C';

function pick<T>(r: Rng, a: readonly T[]): T {
  return a[Math.floor(r() * a.length)];
}

function fill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string): void {
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
  ctx.fill();
}

// ---- primitives -----------------------------------------------------------

/** Shadow of a box, cast down and to the right. */
function shadowBox(dc: DC, x: number, y: number, w: number, d: number, hgt: number): void {
  const { ctx, L } = dc;
  const s = hgt * 0.5 + L * 0.05;
  ctx.fillStyle = 'rgba(18,28,22,0.24)';
  ctx.beginPath();
  ctx.moveTo(x + w, y + hgt * 0.35);
  ctx.lineTo(x + w + s, y + hgt * 0.35 + s * 0.4);
  ctx.lineTo(x + w + s, y + d + s * 0.4);
  ctx.lineTo(x + s * 0.6, y + d + s * 0.4);
  ctx.lineTo(x, y + d);
  ctx.closePath();
  ctx.fill();
}

interface BoxOpts {
  roof: string;
  wall: string;
  glass?: string;
  /** Window rows per 0.14 tiles of height; 0 disables windows. */
  windows?: boolean;
  bands?: boolean;
  parapet?: boolean;
  rng?: Rng;
  roofBits?: number;
  lit?: number;
}

/** Flat-roofed box: roof on top, facade below, shadow to the SE. */
function box(dc: DC, x: number, y: number, w: number, d: number, hgt: number, o: BoxOpts): void {
  const { ctx, L } = dc;
  hgt = Math.min(hgt, d * 0.92);
  shadowBox(dc, x, y, w, d, hgt);
  const fy = y + d - hgt;
  const rh = d - hgt;
  // Facade.
  fill(ctx, x, fy, w, hgt, shade(o.wall, 0.8));
  if (o.windows !== false && hgt > 2.5) {
    const glass = o.glass ?? '#2E3F4F';
    if (L >= 20) {
      const floorH = Math.max(3, L * 0.13);
      const floors = Math.max(1, Math.floor((hgt - L * 0.04) / floorH));
      const colW = Math.max(3, L * (o.bands ? 0.5 : 0.15));
      const cols = Math.max(1, Math.floor((w - L * 0.06) / colW));
      const gw = (w - L * 0.06) / cols;
      const gh = (hgt - L * 0.04) / floors;
      for (let f = 0; f < floors; f++) {
        for (let c = 0; c < cols; c++) {
          const lit = o.rng && o.lit && o.rng() < o.lit;
          ctx.fillStyle = lit ? '#F4E3A1' : glass;
          if (o.bands) ctx.fillRect(x + L * 0.03, fy + L * 0.02 + f * gh + gh * 0.25, w - L * 0.06, gh * 0.5);
          else ctx.fillRect(x + L * 0.03 + c * gw + gw * 0.22, fy + L * 0.02 + f * gh + gh * 0.22, gw * 0.56, gh * 0.52);
        }
        if (o.bands) break;
      }
      if (o.bands) {
        for (let f = 0; f < floors; f++) fill(ctx, x + L * 0.03, fy + L * 0.02 + f * gh + gh * 0.25, w - L * 0.06, gh * 0.5, glass);
      }
    } else if (L >= 12) {
      const floors = Math.max(1, Math.floor(hgt / 3));
      for (let f = 0; f < floors; f++) fill(ctx, x + 1, fy + 1 + f * (hgt / floors), w - 2, Math.max(0.6, hgt / floors / 2.4), o.glass ?? '#2E3F4F');
    }
  }
  // Roof.
  fill(ctx, x, y, w, rh, o.roof);
  if (L >= 12) {
    // Light from the upper left: bright top edge, darker bottom edge.
    fill(ctx, x, y, w, Math.max(1, L * 0.025), shade(o.roof, 1.18));
    fill(ctx, x, y + rh - Math.max(1, L * 0.02), w, Math.max(1, L * 0.02), shade(o.roof, 0.78));
  }
  if (o.parapet && L >= 16) {
    ctx.strokeStyle = shade(o.roof, 0.82);
    ctx.lineWidth = Math.max(1, L * 0.035);
    const inset = L * 0.05;
    ctx.strokeRect(x + inset, y + inset, w - inset * 2, rh - inset * 2);
  }
  if (o.roofBits && o.rng && L >= 16) {
    for (let k = 0; k < o.roofBits; k++) {
      const bw = L * (0.1 + o.rng() * 0.12);
      const bh = L * (0.08 + o.rng() * 0.1);
      const bx = x + L * 0.08 + o.rng() * Math.max(0, w - bw - L * 0.16);
      const by = y + L * 0.08 + o.rng() * Math.max(0, rh - bh - L * 0.16);
      if (o.rng() < 0.3) {
        circle(ctx, bx + bw / 2, by + bw / 2, bw / 2, shade(o.roof, 1.25));
        circle(ctx, bx + bw / 2 - bw * 0.1, by + bw / 2 - bw * 0.1, bw / 3.2, shade(o.roof, 1.4));
      } else {
        fill(ctx, bx + L * 0.02, by + L * 0.02, bw, bh, 'rgba(0,0,0,0.18)');
        fill(ctx, bx, by, bw, bh, shade(o.roof, 1.22));
      }
    }
  }
}

/** Gabled house. `horiz` runs the ridge east-west. */
function house(dc: DC, x: number, y: number, w: number, d: number, hgt: number, roof: string, wall: string, horiz: boolean, r: Rng): void {
  const { ctx, L } = dc;
  shadowBox(dc, x, y, w, d, hgt);
  const fy = y + d - hgt;
  const rh = d - hgt;
  fill(ctx, x + w * 0.04, fy, w * 0.92, hgt, shade(wall, 0.92));
  if (L >= 20) {
    const dw = Math.max(1.5, w * 0.13);
    const dx = x + w * (0.25 + r() * 0.45);
    fill(ctx, dx, fy + hgt * 0.35, dw, hgt * 0.65, shade(roof, 0.55));
    const ww = Math.max(1.5, w * 0.14);
    for (const wx of [x + w * 0.12, x + w * 0.74]) {
      if (Math.abs(wx - dx) < ww * 1.2) continue;
      fill(ctx, wx, fy + hgt * 0.28, ww, hgt * 0.36, '#6E8FA8');
    }
  }
  if (horiz) {
    fill(ctx, x, y, w, rh / 2, shade(roof, 1.1));
    fill(ctx, x, y + rh / 2, w, rh / 2, shade(roof, 0.8));
    if (L >= 16) fill(ctx, x, y + rh / 2 - Math.max(0.5, L * 0.012), w, Math.max(1, L * 0.024), shade(roof, 1.3));
  } else {
    fill(ctx, x, y, w / 2, rh, shade(roof, 1.08));
    fill(ctx, x + w / 2, y, w / 2, rh, shade(roof, 0.78));
    if (L >= 16) fill(ctx, x + w / 2 - Math.max(0.5, L * 0.012), y, Math.max(1, L * 0.024), rh, shade(roof, 1.25));
  }
  if (L >= 24 && r() < 0.6) {
    const cx = x + w * (0.2 + r() * 0.5);
    fill(ctx, cx, y + rh * 0.15, L * 0.06, L * 0.08, shade(roof, 0.5));
  }
}

function tree(dc: DC, x: number, y: number, rad: number, col: string, conifer: boolean): void {
  const { ctx } = dc;
  ctx.fillStyle = 'rgba(15,30,15,0.22)';
  ctx.beginPath();
  ctx.ellipse(x + rad * 0.35, y + rad * 0.45, rad * 0.95, rad * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  if (conifer) {
    circle(ctx, x, y, rad, shade(col, 0.85));
    ctx.fillStyle = shade(col, 1.12);
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = -Math.PI / 2 + (k * Math.PI * 2) / 5;
      ctx.lineTo(x + Math.cos(a) * rad * 0.95, y + Math.sin(a) * rad * 0.95);
      const b = a + Math.PI / 5;
      ctx.lineTo(x + Math.cos(b) * rad * 0.45, y + Math.sin(b) * rad * 0.45);
    }
    ctx.closePath();
    ctx.fill();
  } else {
    circle(ctx, x, y, rad, col);
    circle(ctx, x - rad * 0.28, y - rad * 0.32, rad * 0.58, shade(col, 1.18));
  }
}

function car(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, wid: number, horiz: boolean, col: string): void {
  const w = horiz ? len : wid;
  const h = horiz ? wid : len;
  fill(ctx, x - w / 2 + wid * 0.15, y - h / 2 + wid * 0.2, w, h, 'rgba(0,0,0,0.25)');
  fill(ctx, x - w / 2, y - h / 2, w, h, col);
  if (len > 4) {
    ctx.fillStyle = 'rgba(40,60,80,0.75)';
    if (horiz) ctx.fillRect(x - w * 0.12, y - h / 2 + h * 0.15, w * 0.3, h * 0.7);
    else ctx.fillRect(x - w / 2 + w * 0.15, y - h * 0.12, w * 0.7, h * 0.3);
  }
}

/** Parking lot with stalls and a few parked cars. */
function parking(dc: DC, x: number, y: number, w: number, h: number, r: Rng, fullness = 0.5): void {
  const { ctx, L } = dc;
  fill(ctx, x, y, w, h, '#6C7073');
  if (L < 16) return;
  const stall = L * 0.2;
  const rows = Math.max(1, Math.floor(h / (L * 0.5)));
  ctx.strokeStyle = 'rgba(240,240,235,0.7)';
  ctx.lineWidth = Math.max(0.6, L * 0.015);
  for (let row = 0; row < rows; row++) {
    const ry = y + row * (h / rows);
    for (let sx = x + L * 0.05; sx + stall <= x + w; sx += stall) {
      ctx.beginPath();
      ctx.moveTo(sx, ry + L * 0.04);
      ctx.lineTo(sx, ry + L * 0.2);
      ctx.stroke();
      if (r() < fullness) car(ctx, sx + stall / 2, ry + L * 0.12, L * 0.14, L * 0.09, false, pick(r, CAR_COLORS));
    }
  }
}

function smokestack(dc: DC, x: number, y: number, rad: number, hgt: number, col: string, kind: 'smoke' | 'steam' = 'smoke'): void {
  const { ctx } = dc;
  // Shadow, shaft, rim.
  ctx.fillStyle = 'rgba(18,28,22,0.25)';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + hgt * 0.6, y + hgt * 0.25);
  ctx.lineTo(x + hgt * 0.6 + rad, y + hgt * 0.25 + rad);
  ctx.lineTo(x + rad, y + rad);
  ctx.fill();
  fill(ctx, x - rad, y - hgt, rad * 2, hgt, shade(col, 0.85));
  fill(ctx, x - rad, y - hgt, rad * 0.7, hgt, shade(col, 1.05));
  if (hgt > rad * 5) {
    fill(ctx, x - rad, y - hgt + hgt * 0.08, rad * 2, hgt * 0.08, '#C0392B');
    fill(ctx, x - rad, y - hgt + hgt * 0.24, rad * 2, hgt * 0.06, '#ECEFF1');
  }
  circle(ctx, x, y - hgt, rad, shade(col, 1.1));
  circle(ctx, x, y - hgt, rad * 0.6, '#2A2A2A');
  dc.emit?.({ kind, x: x / dc.L, y: (y - hgt) / dc.L, size: rad / dc.L });
}

function tank(dc: DC, x: number, y: number, rad: number, col: string): void {
  const { ctx } = dc;
  ctx.fillStyle = 'rgba(18,28,22,0.24)';
  ctx.beginPath();
  ctx.ellipse(x + rad * 0.35, y + rad * 0.3, rad, rad, 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(x - rad * 0.4, y - rad * 0.4, rad * 0.1, x, y, rad);
  g.addColorStop(0, shade(col, 1.25));
  g.addColorStop(1, shade(col, 0.78));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fill();
}

// ---- terrain features -----------------------------------------------------

export function drawTrees(dc: DC, tx: number, ty: number): void {
  const { ctx, L, world } = dc;
  const i = ty * world.w + tx;
  const dens = world.trees[i];
  if (!dens) return;
  const X = tx * L;
  const Y = ty * L;
  const h = world.height[i];
  if (L <= 8) {
    ctx.fillStyle = dens >= 3 ? 'rgba(34,74,36,0.9)' : dens === 2 ? 'rgba(46,92,44,0.75)' : 'rgba(58,104,50,0.55)';
    const inset = dens >= 2 ? 0 : L * 0.2;
    ctx.fillRect(X + inset, Y + inset, L - inset * 2, L - inset * 2);
    return;
  }
  const count = [0, 2, 4, 6][dens];
  const pts: [number, number, number][] = [];
  for (let k = 0; k < count; k++) {
    const hx = hash3(tx, ty, k * 3 + 1);
    const hy = hash3(tx, ty, k * 3 + 2);
    const hr = hash3(tx, ty, k * 3 + 3);
    const rad = L * (0.15 + hr * 0.08) * (dens === 3 ? 1.1 : 1);
    pts.push([X + rad + hx * (L - rad * 2), Y + rad + hy * (L - rad * 2), rad]);
  }
  pts.sort((a, b) => a[1] - b[1]);
  const conShare = Math.max(0, Math.min(1, (h - 60) / 80));
  for (let k = 0; k < pts.length; k++) {
    const [x, y, rad] = pts[k];
    const conifer = hash3(tx, ty, 90 + k) < conShare;
    const tone = hash3(tx, ty, 50 + k);
    const col = conifer ? (tone < 0.5 ? '#2C5A3E' : '#355F45') : tone < 0.33 ? '#3F7D36' : tone < 0.66 ? '#4B8A3B' : '#57924A';
    tree(dc, x, y, rad, col, conifer);
  }
}

export function drawRubble(dc: DC, tx: number, ty: number): void {
  const { ctx, L } = dc;
  const X = tx * L;
  const Y = ty * L;
  fill(ctx, X, Y, L, L, 'rgba(120,108,94,0.85)');
  if (L < 12) return;
  const n = L >= 32 ? 9 : 5;
  for (let k = 0; k < n; k++) {
    const s = L * (0.08 + hash3(tx, ty, k) * 0.14);
    const x = X + hash3(tx, ty, k + 20) * (L - s);
    const y = Y + hash3(tx, ty, k + 40) * (L - s);
    const tone = 0.6 + hash3(tx, ty, k + 60) * 0.6;
    fill(ctx, x + s * 0.2, y + s * 0.25, s, s * 0.8, 'rgba(0,0,0,0.2)');
    fill(ctx, x, y, s, s * 0.8, shade('#9C9184', tone));
  }
}

export function drawRadiation(dc: DC, tx: number, ty: number): void {
  const { ctx, L } = dc;
  const X = tx * L;
  const Y = ty * L;
  fill(ctx, X, Y, L, L, 'rgba(214,190,40,0.35)');
  if (L >= 24 && (tx + ty) % 3 === 0) {
    const cx = X + L / 2;
    const cy = Y + L / 2;
    ctx.fillStyle = 'rgba(30,30,20,0.65)';
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, L * 0.3, a - 0.5, a + 0.5);
      ctx.closePath();
      ctx.fill();
    }
    circle(ctx, cx, cy, L * 0.07, 'rgba(214,190,40,1)');
  }
}

// ---- networks -------------------------------------------------------------

const N = 1, E = 2, S = 4, W = 8;

function connMask(world: World, x: number, y: number, test: (i: number) => boolean): number {
  let m = 0;
  if (y > 0 && test((y - 1) * world.w + x)) m |= N;
  if (x < world.w - 1 && test(y * world.w + x + 1)) m |= E;
  if (y < world.h - 1 && test((y + 1) * world.w + x)) m |= S;
  if (x > 0 && test(y * world.w + x - 1)) m |= W;
  return m;
}

function bits(m: number): number {
  return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
}

/** For a 2-connection corner, the tile corner the curve wraps around. */
function cornerOf(m: number): [number, number, number, number] | null {
  // [cornerX, cornerY, startAngle, endAngle] in tile units.
  switch (m) {
    case N | E: return [1, 0, Math.PI / 2, Math.PI];
    case E | S: return [1, 1, Math.PI, Math.PI * 1.5];
    case S | W: return [0, 1, Math.PI * 1.5, Math.PI * 2];
    case W | N: return [0, 0, 0, Math.PI / 2];
  }
  return null;
}

/** Draw a band of width `bw` from the tile centre to each connected edge. */
function arms(ctx: CanvasRenderingContext2D, X: number, Y: number, L: number, m: number, bw: number, col: string, capCentre = true): void {
  ctx.fillStyle = col;
  const c = L / 2;
  const h = bw / 2;
  if (capCentre || !m) ctx.fillRect(X + c - h, Y + c - h, bw, bw);
  if (m & N) ctx.fillRect(X + c - h, Y, bw, c + h);
  if (m & S) ctx.fillRect(X + c - h, Y + c - h, bw, c + h);
  if (m & W) ctx.fillRect(X, Y + c - h, c + h, bw);
  if (m & E) ctx.fillRect(X + c - h, Y + c - h, c + h, bw);
}

function arcBand(ctx: CanvasRenderingContext2D, X: number, Y: number, L: number, cor: [number, number, number, number], rad: number, bw: number, col: string, dash?: number[]): void {
  ctx.strokeStyle = col;
  ctx.lineWidth = bw;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.arc(X + cor[0] * L, Y + cor[1] * L, rad, cor[2], cor[3]);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}

export function drawNet(dc: DC, tx: number, ty: number): void {
  const { world } = dc;
  const i = ty * world.w + tx;
  const v = world.net[i];
  if (!v) return;
  const wet = world.water[i] === 1;
  if (v & ROAD) drawRoad(dc, tx, ty, connMask(world, tx, ty, (j) => (world.net[j] & ROAD) !== 0), wet);
  if (v & RAIL) drawRail(dc, tx, ty, connMask(world, tx, ty, (j) => (world.net[j] & RAIL) !== 0), wet, (v & ROAD) !== 0);
  if (v & POWER) {
    // Standalone lines reach into the buildings they feed; lines strung
    // along a road just follow the road.
    const alone = !(v & (ROAD | RAIL));
    const m = connMask(world, tx, ty, (j) => {
      if (world.net[j] & POWER) return true;
      if (!alone) return false;
      const id = world.occ[j];
      return id !== 0 && world.buildings.get(id)?.kind !== 'park';
    });
    drawPower(dc, tx, ty, m, (v & (ROAD | RAIL)) !== 0, wet);
  }
}

function drawRoad(dc: DC, tx: number, ty: number, m: number, bridge: boolean): void {
  const { ctx, L } = dc;
  const X = tx * L;
  const Y = ty * L;
  const c = L / 2;
  const rw = L * 0.6;
  const sw = L * 0.8;
  if (bridge) {
    const horiz = (m & (E | W)) !== 0 || !(m & (N | S));
    ctx.fillStyle = 'rgba(10,30,50,0.3)';
    if (horiz) ctx.fillRect(X, Y + c - sw / 2 + L * 0.14, L, sw);
    else ctx.fillRect(X + c - sw / 2 + L * 0.14, Y, sw, L);
    ctx.fillStyle = '#A8A398';
    if (horiz) ctx.fillRect(X, Y + c - sw / 2, L, sw);
    else ctx.fillRect(X + c - sw / 2, Y, sw, L);
    ctx.fillStyle = ASPHALT;
    if (horiz) ctx.fillRect(X, Y + c - rw / 2, L, rw);
    else ctx.fillRect(X + c - rw / 2, Y, rw, L);
    if (L >= 16) {
      ctx.fillStyle = '#6B665E';
      const t = Math.max(1, L * 0.04);
      if (horiz) {
        ctx.fillRect(X, Y + c - sw / 2, L, t);
        ctx.fillRect(X, Y + c + sw / 2 - t, L, t);
      } else {
        ctx.fillRect(X + c - sw / 2, Y, t, L);
        ctx.fillRect(X + c + sw / 2 - t, Y, t, L);
      }
    }
    if (L >= 24) {
      ctx.strokeStyle = LANE;
      ctx.lineWidth = Math.max(1, L * 0.03);
      ctx.setLineDash([L * 0.16, L * 0.12]);
      ctx.beginPath();
      if (horiz) {
        ctx.moveTo(X, Y + c);
        ctx.lineTo(X + L, Y + c);
      } else {
        ctx.moveTo(X + c, Y);
        ctx.lineTo(X + c, Y + L);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    return;
  }
  const cor = cornerOf(m);
  if (cor) {
    if (L >= 12) arcBand(ctx, X, Y, L, cor, c, sw, CURB);
    arcBand(ctx, X, Y, L, cor, c, rw, ASPHALT);
    if (L >= 24) arcBand(ctx, X, Y, L, cor, c, Math.max(1, L * 0.03), LANE, [L * 0.16, L * 0.12]);
    return;
  }
  if (L >= 12) arms(ctx, X, Y, L, m, sw, CURB);
  arms(ctx, X, Y, L, m, rw, ASPHALT);
  const n = bits(m);
  if (L >= 24) {
    ctx.strokeStyle = LANE;
    ctx.lineWidth = Math.max(1, L * 0.03);
    if (m === (N | S) || m === (E | W) || n === 1) {
      ctx.setLineDash([L * 0.16, L * 0.12]);
      ctx.beginPath();
      if (m & (N | S)) {
        ctx.moveTo(X + c, m & N ? Y : Y + c);
        ctx.lineTo(X + c, m & S ? Y + L : Y + c);
      } else {
        ctx.moveTo(m & W ? X : X + c, Y + c);
        ctx.lineTo(m & E ? X + L : X + c, Y + c);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (n >= 3 && L >= 32) {
      // Crosswalk stripes on each arm.
      ctx.fillStyle = 'rgba(245,245,240,0.85)';
      const st = L * 0.05;
      for (let k = 0; k < 5; k++) {
        const o = c - rw / 2 + st * 0.6 + k * (rw / 5);
        if (m & N) ctx.fillRect(X + o, Y + L * 0.02, st, L * 0.1);
        if (m & S) ctx.fillRect(X + o, Y + L * 0.88, st, L * 0.1);
        if (m & W) ctx.fillRect(X + L * 0.02, Y + o, L * 0.1, st);
        if (m & E) ctx.fillRect(X + L * 0.88, Y + o, L * 0.1, st);
      }
    }
  }
}

function drawRail(dc: DC, tx: number, ty: number, m: number, bridge: boolean, onRoad: boolean): void {
  const { ctx, L } = dc;
  const X = tx * L;
  const Y = ty * L;
  const c = L / 2;
  const gauge = L * 0.11;
  const railW = Math.max(1, L * 0.035);
  const cor = onRoad ? null : cornerOf(m);
  if (bridge) {
    const horiz = (m & (E | W)) !== 0 || !(m & (N | S));
    ctx.fillStyle = 'rgba(10,30,50,0.3)';
    if (horiz) ctx.fillRect(X, Y + c - L * 0.25 + L * 0.14, L, L * 0.5);
    else ctx.fillRect(X + c - L * 0.25 + L * 0.14, Y, L * 0.5, L);
    ctx.fillStyle = '#5F6770';
    if (horiz) ctx.fillRect(X, Y + c - L * 0.25, L, L * 0.5);
    else ctx.fillRect(X + c - L * 0.25, Y, L * 0.5, L);
    if (L >= 16) {
      ctx.strokeStyle = '#3E454C';
      ctx.lineWidth = Math.max(1, L * 0.03);
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = k * (L / 4);
        if (horiz) {
          ctx.moveTo(X + a, Y + c - L * 0.25);
          ctx.lineTo(X + a + L / 4, Y + c + L * 0.25);
        } else {
          ctx.moveTo(X + c - L * 0.25, Y + a);
          ctx.lineTo(X + c + L * 0.25, Y + a + L / 4);
        }
      }
      ctx.stroke();
    }
  } else if (!onRoad) {
    if (cor) arcBand(ctx, X, Y, L, cor, c, L * 0.42, '#8E8579');
    else arms(ctx, X, Y, L, m, L * 0.42, '#8E8579');
  }
  // Sleepers.
  if (L >= 16 && !onRoad) {
    ctx.strokeStyle = '#5A4636';
    ctx.lineWidth = Math.max(1, L * 0.05);
    ctx.beginPath();
    const tie = gauge * 1.7;
    if (cor) {
      for (let k = 1; k < 5; k++) {
        const a = cor[2] + ((cor[3] - cor[2]) * k) / 5;
        const cx = X + cor[0] * L;
        const cy = Y + cor[1] * L;
        ctx.moveTo(cx + Math.cos(a) * (c - tie), cy + Math.sin(a) * (c - tie));
        ctx.lineTo(cx + Math.cos(a) * (c + tie), cy + Math.sin(a) * (c + tie));
      }
    } else {
      const step = L / 5;
      for (let k = 0; k < 5; k++) {
        const o = step * (k + 0.5);
        const inV = (o < c && m & N) || (o >= c && m & S) || (!(m & (E | W)) && !m);
        const inH = (o < c && m & W) || (o >= c && m & E);
        if (inV) {
          ctx.moveTo(X + c - tie, Y + o);
          ctx.lineTo(X + c + tie, Y + o);
        }
        if (inH) {
          ctx.moveTo(X + o, Y + c - tie);
          ctx.lineTo(X + o, Y + c + tie);
        }
      }
    }
    ctx.stroke();
  }
  // Rails.
  const steel = '#C9CED4';
  if (cor) {
    arcBand(ctx, X, Y, L, cor, c - gauge, railW, steel);
    arcBand(ctx, X, Y, L, cor, c + gauge, railW, steel);
    return;
  }
  ctx.fillStyle = steel;
  const seg = (vert: boolean, from: number, to: number) => {
    if (vert) {
      ctx.fillRect(X + c - gauge - railW / 2, Y + from, railW, to - from);
      ctx.fillRect(X + c + gauge - railW / 2, Y + from, railW, to - from);
    } else {
      ctx.fillRect(X + from, Y + c - gauge - railW / 2, to - from, railW);
      ctx.fillRect(X + from, Y + c + gauge - railW / 2, to - from, railW);
    }
  };
  if (!m) seg(true, L * 0.2, L * 0.8);
  if (m & N) seg(true, 0, c + gauge);
  if (m & S) seg(true, c - gauge, L);
  if (m & W) seg(false, 0, c + gauge);
  if (m & E) seg(false, c - gauge, L);
  if (onRoad && L >= 24) {
    // Level crossing markings.
    ctx.fillStyle = 'rgba(245,245,240,0.8)';
    const vert = (m & (N | S)) !== 0;
    for (const o of [-0.3, 0.3]) {
      if (vert) ctx.fillRect(X + c + o * L - L * 0.02, Y + L * 0.1, L * 0.04, L * 0.8);
      else ctx.fillRect(X + L * 0.1, Y + c + o * L - L * 0.02, L * 0.8, L * 0.04);
    }
  }
}

function drawPower(dc: DC, tx: number, ty: number, m: number, onOther: boolean, wet: boolean): void {
  const { ctx, L } = dc;
  const X = tx * L;
  const Y = ty * L;
  const c = L / 2;
  const off = L * 0.07;
  ctx.strokeStyle = 'rgba(40,34,30,0.85)';
  ctx.lineWidth = Math.max(0.7, L * 0.02);
  ctx.beginPath();
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.moveTo(X + x0, Y + y0);
    ctx.lineTo(X + x1, Y + y1);
  };
  if (m & N) { line(c - off, c, c - off, 0); line(c + off, c, c + off, 0); }
  if (m & S) { line(c - off, c, c - off, L); line(c + off, c, c + off, L); }
  if (m & W) { line(c, c - off, 0, c - off); line(c, c + off, 0, c + off); }
  if (m & E) { line(c, c - off, L, c - off); line(c, c + off, L, c + off); }
  ctx.stroke();
  if (onOther) return;
  const p = Math.max(1.5, L * 0.1);
  if (wet) {
    fill(ctx, X + c - p * 0.7 + p * 0.3, Y + c - p * 0.7 + p * 0.4, p * 1.4, p * 1.4, 'rgba(0,0,0,0.25)');
    ctx.strokeStyle = '#8A9199';
    ctx.lineWidth = Math.max(1, L * 0.03);
    ctx.strokeRect(X + c - p * 0.7, Y + c - p * 0.7, p * 1.4, p * 1.4);
    return;
  }
  const vert = (m & (N | S)) !== 0 && !(m & (E | W));
  fill(ctx, X + c - p / 2 + p * 0.4, Y + c - p / 2 + p * 0.5, p, p, 'rgba(0,0,0,0.25)');
  fill(ctx, X + c - p / 2, Y + c - p / 2, p, p, '#7A5A3C');
  if (L >= 16) {
    if (vert) fill(ctx, X + c - off * 1.6, Y + c - L * 0.02, off * 3.2, L * 0.04, '#5C4330');
    else fill(ctx, X + c - L * 0.02, Y + c - off * 1.6, L * 0.04, off * 3.2, '#5C4330');
  }
}

// ---- buildings ------------------------------------------------------------

export function buildingRng(b: Building): Rng {
  return makeRng((b.seed ^ Math.imul(b.level + 1, 0x9e3779b1)) >>> 0);
}

export function drawBuilding(dc: DC, b: Building): void {
  const { ctx, L } = dc;
  const X = b.x * L;
  const Y = b.y * L;
  const S = b.size * L;
  ctx.save();
  ctx.beginPath();
  ctx.rect(X, Y, S, S);
  ctx.clip();
  const r = buildingRng(b);
  switch (b.kind) {
    case 'res': drawRes(dc, b, X, Y, r); break;
    case 'com': drawCom(dc, b, X, Y, r); break;
    case 'ind': drawInd(dc, b, X, Y, r); break;
    case 'park': drawPark(dc, b, X, Y, r); break;
    case 'police': drawPolice(dc, X, Y, r); break;
    case 'fire': drawFireStation(dc, X, Y, r); break;
    case 'school': drawSchool(dc, X, Y, r); break;
    case 'hospital': drawHospital(dc, X, Y, r); break;
    case 'stadium': drawStadium(dc, X, Y); break;
    case 'seaport': drawSeaport(dc, b, X, Y, r); break;
    case 'airport': drawAirport(dc, X, Y, r); break;
    case 'coal': drawCoal(dc, X, Y, r); break;
    case 'nuclear': drawNuclear(dc, X, Y); break;
    case 'wind': drawWind(dc, X, Y); break;
    case 'solar': drawSolar(dc, X, Y); break;
  }
  ctx.restore();
}

function vacantLot(dc: DC, b: Building, X: number, Y: number): void {
  const { ctx, L } = dc;
  const S = b.size * L;
  const col = ZONE_MAP_COLORS[b.kind as 'res' | 'com' | 'ind'];
  fill(ctx, X, Y, S, S, shade(col, 1, 0.13));
  ctx.strokeStyle = shade(col, 1, 0.9);
  ctx.lineWidth = Math.max(1, L * 0.06);
  if (L >= 12) ctx.setLineDash([L * 0.22, L * 0.14]);
  const ins = Math.max(1, L * 0.1);
  ctx.strokeRect(X + ins, Y + ins, S - ins * 2, S - ins * 2);
  ctx.setLineDash([]);
  if (L >= 10) {
    const bs = L * 0.95;
    const cx = X + S / 2;
    const cy = Y + S / 2;
    ctx.fillStyle = shade(col, 0.72);
    roundRect(ctx, cx - bs / 2, cy - bs / 2, bs, bs, bs * 0.18);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 ${Math.round(bs * 0.62)}px Overpass, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.kind === 'res' ? 'R' : b.kind === 'com' ? 'C' : 'I', cx, cy + bs * 0.05);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawRes(dc: DC, b: Building, X: number, Y: number, r: Rng): void {
  const { ctx, L } = dc;
  if (b.level === 0) return vacantLot(dc, b, X, Y);
  if (b.level <= 4) {
    // Suburban lots, one house per tile, growing in from the corners.
    fill(ctx, X, Y, L * 3, L * 3, 'rgba(150,200,110,0.28)');
    const order = [0, 2, 6, 8, 1, 7, 3, 5, 4];
    for (let k = order.length - 1; k > 0; k--) {
      const j = Math.floor(r() * (k + 1));
      if (j === 4 || k === 4) continue;
      [order[k], order[j]] = [order[j], order[k]];
    }
    const houses = b.level * 2;
    const roofBase = pick(r, ROOFS);
    for (let k = 0; k < 9; k++) {
      const sub = order[k];
      const sx = X + (sub % 3) * L;
      const sy = Y + Math.floor(sub / 3) * L;
      if (k < houses) {
        const w = L * (0.52 + r() * 0.22);
        const d = L * (0.5 + r() * 0.2);
        const hx = sx + (L - w) * (0.3 + r() * 0.4);
        const hy = sy + (L - d) * (0.25 + r() * 0.3);
        if (L >= 24) fill(ctx, hx + w * 0.3, hy + d, w * 0.22, sy + L - hy - d, '#B9B3A6');
        house(dc, hx, hy, w, d, L * 0.2, r() < 0.5 ? roofBase : pick(r, ROOFS), pick(r, WALLS), r() < 0.55, r);
        if (L >= 16 && r() < 0.5) tree(dc, sx + L * (0.15 + r() * 0.7), sy + L * 0.86, L * 0.12, '#4B8A3B', false);
      } else if (L >= 16) {
        if (r() < 0.7) tree(dc, sx + L * (0.3 + r() * 0.4), sy + L * (0.3 + r() * 0.4), L * (0.14 + r() * 0.06), '#4B8A3B', false);
      }
    }
    return;
  }
  fill(ctx, X, Y, L * 3, L * 3, 'rgba(196,190,178,0.75)');
  if (b.level === 5) {
    // Terraced row houses.
    for (let row = 0; row < 3; row++) {
      const ry = Y + row * L + L * 0.1;
      const units = 4 + Math.floor(r() * 2);
      const uw = (L * 2.8) / units;
      const roof = pick(r, ROOFS);
      for (let u = 0; u < units; u++) {
        house(dc, X + L * 0.1 + u * uw, ry, uw + 0.5, L * 0.62, L * 0.24, roof, pick(r, WALLS), true, r);
      }
      fill(ctx, X + L * 0.1, ry + L * 0.66, L * 2.8, L * 0.22, 'rgba(120,170,90,0.55)');
    }
    return;
  }
  if (b.level <= 7) {
    // Apartment blocks around a courtyard.
    fill(ctx, X + L * 0.3, Y + L * 1.3, L * 2.4, L * 0.5, 'rgba(120,170,90,0.7)');
    const hgt = b.level === 6 ? L * 0.42 : L * 0.72;
    const wall = pick(r, APT_WALLS);
    const roof = pick(r, FLAT_ROOFS);
    box(dc, X + L * 0.12, Y + L * 0.1, L * 2.76, L * 1.25, hgt, { roof, wall, rng: r, parapet: true, roofBits: 3, lit: 0.08 });
    box(dc, X + L * 0.12, Y + L * 1.62, L * (b.level === 7 ? 1.3 : 2.76), L * 1.28, hgt, { roof, wall: pick(r, APT_WALLS), rng: r, parapet: true, roofBits: 2, lit: 0.08 });
    if (b.level === 7) box(dc, X + L * 1.58, Y + L * 1.62, L * 1.3, L * 1.28, hgt * 1.2, { roof: pick(r, FLAT_ROOFS), wall, rng: r, parapet: true, roofBits: 2 });
    if (L >= 16 && b.level === 6) {
      tree(dc, X + L * 0.5, Y + L * 1.52, L * 0.14, '#4B8A3B', false);
      tree(dc, X + L * 2.5, Y + L * 1.52, L * 0.14, '#4B8A3B', false);
    }
    return;
  }
  // Level 8: towers on a plaza.
  fill(ctx, X, Y, L * 3, L * 3, 'rgba(206,200,188,0.9)');
  const roof = pick(r, FLAT_ROOFS);
  box(dc, X + L * 0.12, Y + L * 0.12, L * 1.3, L * 2.7, L * 1.5, { roof, wall: pick(r, APT_WALLS), rng: r, parapet: true, roofBits: 3, lit: 0.1 });
  box(dc, X + L * 1.6, Y + L * 0.5, L * 1.28, L * 2.35, L * 1.2, { roof: pick(r, FLAT_ROOFS), wall: pick(r, APT_WALLS), rng: r, parapet: true, roofBits: 2, lit: 0.1 });
}

function drawCom(dc: DC, b: Building, X: number, Y: number, r: Rng): void {
  const { ctx, L } = dc;
  if (b.level === 0) return vacantLot(dc, b, X, Y);
  fill(ctx, X, Y, L * 3, L * 3, 'rgba(200,196,186,0.85)');
  switch (b.level) {
    case 1: {
      parking(dc, X + L * 0.1, Y + L * 1.75, L * 2.8, L * 1.1, r, 0.45);
      const n = 2 + Math.floor(r() * 2);
      const sw = (L * 2.8) / n;
      for (let k = 0; k < n; k++) {
        const x = X + L * 0.1 + k * sw + L * 0.05;
        const w = sw - L * 0.1;
        box(dc, x, Y + L * 0.15, w, L * 1.4, L * 0.28, { roof: pick(r, FLAT_ROOFS), wall: pick(r, WALLS), windows: false, rng: r, roofBits: 1 });
        awning(dc, x, Y + L * 1.55 - L * 0.06, w, pick(r, AWNINGS));
      }
      break;
    }
    case 2: {
      const n = 3 + Math.floor(r() * 2);
      const sw = (L * 2.8) / n;
      for (let k = 0; k < n; k++) {
        const x = X + L * 0.1 + k * sw;
        const hgt = L * (0.3 + r() * 0.2);
        box(dc, x, Y + L * 0.1, sw - L * 0.04, L * 1.7, hgt, { roof: pick(r, FLAT_ROOFS), wall: pick(r, [...WALLS, ...APT_WALLS]), glass: '#3B4A58', rng: r, parapet: true, roofBits: 1, lit: 0.15 });
        awning(dc, x, Y + L * 1.8 - L * 0.07, sw - L * 0.04, pick(r, AWNINGS));
      }
      parking(dc, X + L * 0.1, Y + L * 2.05, L * 2.8, L * 0.8, r, 0.6);
      break;
    }
    case 3: {
      const g = pick(r, GLASS);
      box(dc, X + L * 0.12, Y + L * 0.12, L * 1.45, L * 1.9, L * 0.62, { roof: pick(r, FLAT_ROOFS), wall: '#C9CCD0', glass: g, rng: r, parapet: true, roofBits: 2, bands: r() < 0.5 });
      box(dc, X + L * 1.72, Y + L * 0.5, L * 1.16, L * 1.5, L * 0.5, { roof: pick(r, FLAT_ROOFS), wall: pick(r, APT_WALLS), glass: '#3B4A58', rng: r, parapet: true, roofBits: 2 });
      parking(dc, X + L * 0.12, Y + L * 2.2, L * 2.76, L * 0.68, r, 0.7);
      break;
    }
    case 4: {
      const g = pick(r, GLASS);
      box(dc, X + L * 0.2, Y + L * 0.15, L * 1.7, L * 2.6, L * 1.2, { roof: '#8E959B', wall: '#B8C2CA', glass: g, rng: r, parapet: true, roofBits: 3, bands: true });
      box(dc, X + L * 2.05, Y + L * 1.2, L * 0.8, L * 1.6, L * 0.4, { roof: pick(r, FLAT_ROOFS), wall: pick(r, APT_WALLS), glass: '#3B4A58', rng: r, roofBits: 1 });
      break;
    }
    default: {
      // Downtown skyscraper on a podium.
      const g = pick(r, GLASS);
      box(dc, X + L * 0.1, Y + L * 1.6, L * 2.8, L * 1.3, L * 0.3, { roof: '#9DA3A8', wall: '#C3C8CC', glass: '#3B4A58', rng: r, roofBits: 2 });
      const tx = X + L * (0.55 + r() * 0.3);
      box(dc, tx, Y + L * 0.1, L * 1.6, L * 2.75, L * 1.85, { roof: '#7F8A93', wall: '#A9B8C4', glass: g, rng: r, bands: r() < 0.5, lit: 0.12 });
      if (L >= 16) {
        // Crown and helipad.
        const rw = L * 1.6;
        const rh = L * 2.75 - L * 1.85;
        fill(ctx, tx + L * 0.12, Y + L * 0.2, rw - L * 0.24, rh - L * 0.2, '#6E7880');
        if (L >= 24) {
          ctx.strokeStyle = '#F1F1EC';
          ctx.lineWidth = Math.max(1, L * 0.03);
          ctx.beginPath();
          ctx.arc(tx + rw / 2, Y + L * 0.1 + rh / 2, Math.min(rw, rh) * 0.3, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#F1F1EC';
          ctx.font = `800 ${Math.round(L * 0.26)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('H', tx + rw / 2, Y + L * 0.1 + rh / 2 + 1);
        }
        dc.emit?.({ kind: 'beacon', x: (tx + rw - L * 0.1) / L, y: (Y + L * 0.18) / L, size: 0.05 });
      }
    }
  }
}

function awning(dc: DC, x: number, y: number, w: number, col: string): void {
  const { ctx, L } = dc;
  if (L < 12) return;
  const h = L * 0.12;
  const n = Math.max(2, Math.round(w / (L * 0.12)));
  for (let k = 0; k < n; k++) fill(ctx, x + (k * w) / n, y, w / n + 0.5, h, k % 2 ? '#F4F1EA' : col);
  fill(ctx, x, y + h, w, Math.max(1, L * 0.03), 'rgba(0,0,0,0.2)');
}

function drawInd(dc: DC, b: Building, X: number, Y: number, r: Rng): void {
  const { ctx, L } = dc;
  if (b.level === 0) return vacantLot(dc, b, X, Y);
  fill(ctx, X, Y, L * 3, L * 3, 'rgba(176,168,150,0.88)');
  const crates = (x: number, y: number, w: number, h: number, n: number) => {
    if (L < 16) return;
    for (let k = 0; k < n; k++) {
      const cw = L * (0.14 + r() * 0.2);
      const ch = L * 0.12;
      const cx = x + r() * (w - cw);
      const cy = y + r() * (h - ch);
      fill(ctx, cx + 1, cy + 1, cw, ch, 'rgba(0,0,0,0.2)');
      fill(ctx, cx, cy, cw, ch, pick(r, ['#B3542E', '#2E6DA4', '#3D8B4F', '#C9A227', '#8A8F94', '#A0522D']));
    }
  };
  const truck = (x: number, y: number) => {
    if (L < 16) return;
    fill(ctx, x + 1, y + 1, L * 0.5, L * 0.16, 'rgba(0,0,0,0.25)');
    fill(ctx, x, y, L * 0.36, L * 0.16, '#E9E6DF');
    fill(ctx, x + L * 0.37, y + L * 0.01, L * 0.13, L * 0.14, pick(r, ['#C0392B', '#2E86DE', '#27AE60']));
  };
  switch (b.level) {
    case 1: {
      box(dc, X + L * 0.15, Y + L * 0.15, L * 1.2, L * 1.0, L * 0.3, { roof: '#8E9AA0', wall: '#B9B2A3', windows: false, rng: r });
      box(dc, X + L * 1.6, Y + L * 0.3, L * 1.2, L * 0.9, L * 0.26, { roof: '#A2735A', wall: '#C2B8A6', windows: false, rng: r });
      crates(X + L * 0.2, Y + L * 1.6, L * 2.6, L * 1.2, 7);
      truck(X + L * 1.8, Y + L * 2.5);
      break;
    }
    case 2: {
      warehouse(dc, X + L * 0.12, Y + L * 0.15, L * 2.76, L * 1.55, L * 0.4, r);
      crates(X + L * 0.2, Y + L * 2.0, L * 1.4, L * 0.9, 6);
      truck(X + L * 1.8, Y + L * 2.0);
      truck(X + L * 2.1, Y + L * 2.45);
      break;
    }
    case 3: {
      warehouse(dc, X + L * 0.12, Y + L * 0.9, L * 1.9, L * 1.35, L * 0.45, r);
      tank(dc, X + L * 2.45, Y + L * 2.45, L * 0.36, '#D6D2C6');
      smokestack(dc, X + L * 2.45, Y + L * 1.8, L * 0.14, L * 1.3, '#8C7B70');
      crates(X + L * 0.2, Y + L * 2.4, L * 1.8, L * 0.5, 5);
      break;
    }
    default: {
      box(dc, X + L * 0.1, Y + L * 0.8, L * 1.9, L * 1.8, L * 0.7, { roof: '#6F7A80', wall: '#9C9689', glass: '#3F4C55', rng: r, bands: true, roofBits: 3 });
      tank(dc, X + L * 2.45, Y + L * 2.5, L * 0.38, '#CFC9BB');
      tank(dc, X + L * 0.5, Y + L * 2.72, L * 0.24, '#B8B2A4');
      smokestack(dc, X + L * 2.3, Y + L * 1.6, L * 0.16, L * 1.45, '#7A6E66');
      smokestack(dc, X + L * 2.75, Y + L * 1.75, L * 0.13, L * 1.25, '#7A6E66');
      if (L >= 16) {
        ctx.strokeStyle = '#8C8F91';
        ctx.lineWidth = Math.max(1, L * 0.05);
        ctx.beginPath();
        ctx.moveTo(X + L * 2.0, Y + L * 2.45);
        ctx.lineTo(X + L * 2.1, Y + L * 2.45);
        ctx.lineTo(X + L * 2.1, Y + L * 2.72);
        ctx.lineTo(X + L * 0.74, Y + L * 2.72);
        ctx.stroke();
      }
    }
  }
}

function warehouse(dc: DC, x: number, y: number, w: number, d: number, hgt: number, r: Rng): void {
  const { ctx, L } = dc;
  box(dc, x, y, w, d, hgt, { roof: '#8E9AA0', wall: '#B4AD9D', windows: false, rng: r });
  const rh = d - hgt;
  if (L >= 12) {
    // Sawtooth roof ridges.
    const n = Math.max(2, Math.round(w / (L * 0.35)));
    for (let k = 0; k < n; k++) {
      const sx = x + (k * w) / n;
      fill(ctx, sx, y, w / n / 2, rh, '#A7B3B8');
      fill(ctx, sx + w / n / 2, y, w / n / 2, rh, '#77838A');
    }
    // Loading doors.
    const doors = Math.max(1, Math.floor(w / (L * 0.45)));
    for (let k = 0; k < doors; k++) {
      fill(ctx, x + (k + 0.3) * (w / doors), y + d - hgt * 0.8, (w / doors) * 0.4, hgt * 0.8, '#5E5A52');
    }
  }
}

function drawPark(dc: DC, b: Building, X: number, Y: number, r: Rng): void {
  const { ctx, L } = dc;
  fill(ctx, X, Y, L, L, '#8CC063');
  if (L < 12) {
    circle(ctx, X + L / 2, Y + L / 2, L * 0.3, '#4B8A3B');
    return;
  }
  const v = b.seed % 4;
  ctx.strokeStyle = '#E3D6B3';
  ctx.lineWidth = L * 0.1;
  ctx.beginPath();
  if (v === 0) {
    ctx.moveTo(X, Y + L * 0.7);
    ctx.quadraticCurveTo(X + L * 0.5, Y + L * 0.3, X + L, Y + L * 0.55);
  } else {
    ctx.moveTo(X + L * 0.3, Y);
    ctx.quadraticCurveTo(X + L * 0.6, Y + L * 0.5, X + L * 0.35, Y + L);
  }
  ctx.stroke();
  if (v === 1) {
    ctx.fillStyle = '#5DA9C9';
    ctx.beginPath();
    ctx.ellipse(X + L * 0.68, Y + L * 0.62, L * 0.2, L * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (v === 2) {
    circle(ctx, X + L * 0.62, Y + L * 0.62, L * 0.16, '#D8D2C2');
    circle(ctx, X + L * 0.62, Y + L * 0.62, L * 0.1, '#7CC4E0');
  }
  const trees = 1 + (b.seed % 3);
  for (let k = 0; k < trees; k++) {
    tree(dc, X + L * (0.2 + r() * 0.6), Y + L * (0.18 + r() * 0.35), L * (0.13 + r() * 0.06), pick(r, ['#3F7D36', '#4B8A3B', '#57924A']), false);
  }
}

function drawPolice(dc: DC, X: number, Y: number, r: Rng): void {
  const { ctx, L } = dc;
  fill(ctx, X, Y, L * 3, L * 3, 'rgba(200,196,186,0.9)');
  box(dc, X + L * 0.15, Y + L * 0.15, L * 2.7, L * 1.55, L * 0.42, { roof: '#3F5A8C', wall: '#D9D6CF', glass: '#2C3E57', rng: r, parapet: true });
  const rh = L * 1.55 - L * 0.42;
  if (L >= 12) star(ctx, X + L * 1.5, Y + L * 0.15 + rh / 2, L * 0.34, '#F2C94C');
  parking(dc, X + L * 0.15, Y + L * 1.95, L * 2.7, L * 0.9, r, 0);
  if (L >= 16) {
    for (let k = 0; k < 3; k++) {
      const cx = X + L * (0.5 + k * 0.6);
      car(ctx, cx, Y + L * 2.3, L * 0.16, L * 0.1, false, '#F5F6FA');
      fill(ctx, cx - L * 0.05, Y + L * 2.28, L * 0.1, L * 0.03, '#1F3A93');
    }
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, col: string): void {
  ctx.fillStyle = col;
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

function drawFireStation(dc: DC, X: number, Y: number, r: Rng): void {
  const { ctx, L } = dc;
  fill(ctx, X, Y, L * 3, L * 3, 'rgba(200,196,186,0.9)');
  box(dc, X + L * 0.15, Y + L * 0.2, L * 2.25, L * 1.7, L * 0.5, { roof: '#8E3B30', wall: '#B5483A', windows: false, rng: r, parapet: true });
  const fy = Y + L * 1.9 - L * 0.5;
  if (L >= 12) {
    for (let k = 0; k < 3; k++) fill(ctx, X + L * (0.3 + k * 0.72), fy + L * 0.12, L * 0.55, L * 0.38, k === 1 ? '#3B3B3B' : '#E7E3DA');
  }
  box(dc, X + L * 2.45, Y + L * 0.15, L * 0.45, L * 1.4, L * 0.95, { roof: '#7A3129', wall: '#A94436', windows: false, rng: r });
  if (L >= 16) {
    fill(ctx, X + L * 0.95, Y + L * 2.1, L * 0.3, L * 0.62, 'rgba(0,0,0,0.25)');
    fill(ctx, X + L * 0.92, Y + L * 2.05, L * 0.28, L * 0.6, '#D0342C');
    fill(ctx, X + L * 0.95, Y + L * 2.1, L * 0.22, L * 0.14, '#E8E8E8');
  }
}

function drawSchool(dc: DC, X: number, Y: number, r: Rng): void {
  const { ctx, L } = dc;
  fill(ctx, X, Y, L * 3, L * 3, '#8FBF65');
  // Running track and field.
  if (L >= 8) {
    ctx.fillStyle = '#C0673F';
    roundRect(ctx, X + L * 1.25, Y + L * 1.3, L * 1.65, L * 1.6, L * 0.7);
    ctx.fill();
    ctx.fillStyle = '#6FAE4A';
    roundRect(ctx, X + L * 1.45, Y + L * 1.5, L * 1.25, L * 1.2, L * 0.5);
    ctx.fill();
    if (L >= 24) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = Math.max(1, L * 0.02);
      ctx.strokeRect(X + L * 1.65, Y + L * 1.7, L * 0.85, L * 0.8);
    }
  }
  box(dc, X + L * 0.1, Y + L * 0.1, L * 2.8, L * 1.05, L * 0.4, { roof: '#9C5B3B', wall: '#D7A65A', glass: '#34495E', rng: r, parapet: true });
  box(dc, X + L * 0.1, Y + L * 1.0, L * 1.0, L * 1.9, L * 0.4, { roof: '#9C5B3B', wall: '#D7A65A', glass: '#34495E', rng: r, parapet: true });
  if (L >= 16) {
    // Flagpole.
    fill(ctx, X + L * 1.25, Y + L * 1.2, Math.max(1, L * 0.03), L * 0.3, '#7F8C8D');
    fill(ctx, X + L * 1.28, Y + L * 1.2, L * 0.14, L * 0.09, '#C0392B');
  }
}

function drawHospital(dc: DC, X: number, Y: number, r: Rng): void {
  const { ctx, L } = dc;
  fill(ctx, X, Y, L * 3, L * 3, 'rgba(206,202,192,0.9)');
  box(dc, X + L * 0.2, Y + L * 0.9, L * 2.6, L * 1.4, L * 0.55, { roof: '#D9D9D3', wall: '#ECEBE6', glass: '#5D7B94', rng: r, parapet: true });
  box(dc, X + L * 0.95, Y + L * 0.1, L * 1.1, L * 2.6, L * 0.75, { roof: '#E4E4DE', wall: '#F2F1EC', glass: '#5D7B94', rng: r, parapet: true });
  const cx = X + L * 1.5;
  const cy = Y + L * 0.1 + (L * 2.6 - L * 0.75) / 2;
  const s = L * 0.2;
  fill(ctx, cx - s * 1.5, cy - s / 2, s * 3, s, '#D0342C');
  fill(ctx, cx - s / 2, cy - s * 1.5, s, s * 3, '#D0342C');
  if (L >= 16) {
    circle(ctx, X + L * 0.55, Y + L * 2.6, L * 0.3, '#7A7F84');
    ctx.fillStyle = '#F4D03F';
    ctx.font = `800 ${Math.round(L * 0.3)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', X + L * 0.55, Y + L * 2.62);
  }
}

function drawStadium(dc: DC, X: number, Y: number): void {
  const { ctx, L } = dc;
  const S = L * 4;
  fill(ctx, X, Y, S, S, 'rgba(200,196,186,0.9)');
  const cx = X + S / 2;
  const cy = Y + S / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(cx + L * 0.15, cy + L * 0.2, S * 0.47, S * 0.43, 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createLinearGradient(X, Y, X + S, Y + S);
  g.addColorStop(0, '#C9CDD1');
  g.addColorStop(1, '#868C92');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, S * 0.47, S * 0.43, 0, 0, Math.PI * 2);
  ctx.fill();
  if (L >= 12) {
    ctx.strokeStyle = 'rgba(80,90,100,0.5)';
    ctx.lineWidth = Math.max(1, L * 0.03);
    for (let k = 1; k <= 3; k++) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, S * (0.47 - k * 0.035), S * (0.43 - k * 0.035), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.fillStyle = '#4E9A3A';
  ctx.beginPath();
  ctx.ellipse(cx, cy, S * 0.3, S * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  if (L >= 12) {
    for (let k = 0; k < 6; k++) {
      if (k % 2) fill(ctx, cx - S * 0.3 + (k * S * 0.6) / 6, cy - S * 0.26, (S * 0.6) / 6, S * 0.52, 'rgba(255,255,255,0.08)');
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, L * 0.025);
    ctx.strokeRect(cx - S * 0.22, cy - S * 0.15, S * 0.44, S * 0.3);
    ctx.beginPath();
    ctx.moveTo(cx, cy - S * 0.15);
    ctx.lineTo(cx, cy + S * 0.15);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, S * 0.05, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) circle(ctx, X + S * fx, Y + S * fy, L * 0.08, '#555B61');
}

function drawSeaport(dc: DC, b: Building, X: number, Y: number, r: Rng): void {
  const { ctx, L, world } = dc;
  const S = L * 4;
  fill(ctx, X, Y, S, S, '#BDB8AD');
  // Which side faces the water?
  const score = [0, 0, 0, 0];
  for (let d = 0; d < 4; d++) {
    const pts: [number, number][] = [[b.x + d, b.y - 1], [b.x + 4, b.y + d], [b.x + d, b.y + 4], [b.x - 1, b.y + d]];
    pts.forEach(([x, y], k) => {
      if (world.inBounds(x, y) && world.water[y * world.w + x]) score[k]++;
    });
  }
  const side = score.indexOf(Math.max(...score));
  const horiz = side === 0 || side === 2;
  // Quay edge.
  ctx.fillStyle = '#8D8779';
  if (side === 0) ctx.fillRect(X, Y, S, L * 0.12);
  if (side === 2) ctx.fillRect(X, Y + S - L * 0.12, S, L * 0.12);
  if (side === 3) ctx.fillRect(X, Y, L * 0.12, S);
  if (side === 1) ctx.fillRect(X + S - L * 0.12, Y, L * 0.12, S);
  // Container stacks.
  const cols = ['#C0392B', '#2980B9', '#27AE60', '#E67E22', '#8E44AD', '#16A085', '#D35400', '#7F8C8D'];
  for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 5; k++) {
      if (r() < 0.2) continue;
      let cx: number, cy: number, cw: number, ch: number;
      if (horiz) {
        cw = L * 0.55; ch = L * 0.22;
        cx = X + L * 0.3 + k * L * 0.68;
        cy = Y + (side === 0 ? L * 1.6 : L * 0.35) + row * L * 0.36;
      } else {
        cw = L * 0.22; ch = L * 0.55;
        cx = X + (side === 3 ? L * 1.6 : L * 0.35) + row * L * 0.36;
        cy = Y + L * 0.3 + k * L * 0.68;
      }
      fill(ctx, cx + L * 0.04, cy + L * 0.05, cw, ch, 'rgba(0,0,0,0.25)');
      fill(ctx, cx, cy, cw, ch, pick(r, cols));
    }
  }
  // Gantry cranes along the quay.
  for (let k = 0; k < 2; k++) {
    let x: number, y: number, w: number, h: number;
    if (horiz) {
      w = L * 0.5; h = L * 1.1;
      x = X + L * (0.8 + k * 1.7);
      y = side === 0 ? Y + L * 0.1 : Y + S - L * 1.2;
    } else {
      w = L * 1.1; h = L * 0.5;
      y = Y + L * (0.8 + k * 1.7);
      x = side === 3 ? X + L * 0.1 : X + S - L * 1.2;
    }
    fill(ctx, x + L * 0.25, y + L * 0.3, w, h, 'rgba(0,0,0,0.28)');
    ctx.strokeStyle = '#E2A21B';
    ctx.lineWidth = Math.max(1.5, L * 0.08);
    ctx.strokeRect(x, y, w, h);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y + h);
    ctx.stroke();
  }
}

function drawAirport(dc: DC, X: number, Y: number, r: Rng): void {
  const { ctx, L } = dc;
  const S = L * 6;
  fill(ctx, X, Y, S, S, 'rgba(160,190,120,0.6)');
  // Runway.
  fill(ctx, X + L * 0.1, Y + L * 0.7, S - L * 0.2, L * 0.85, '#4A4E52');
  if (L >= 12) {
    ctx.fillStyle = '#F1F1EC';
    for (let x = X + L * 0.9; x < X + S - L * 1.0; x += L * 0.6) ctx.fillRect(x, Y + L * 1.1, L * 0.3, Math.max(1, L * 0.05));
    for (let k = 0; k < 4; k++) {
      ctx.fillRect(X + L * 0.2, Y + L * (0.78 + k * 0.18), L * 0.4, L * 0.08);
      ctx.fillRect(X + S - L * 0.6, Y + L * (0.78 + k * 0.18), L * 0.4, L * 0.08);
    }
  }
  // Taxiway and apron.
  fill(ctx, X + L * 0.6, Y + L * 2.2, S - L * 1.2, L * 0.35, '#5B6064');
  fill(ctx, X + L * 1.5, Y + L * 1.55, L * 0.3, L * 0.7, '#5B6064');
  fill(ctx, X + L * 4.2, Y + L * 1.55, L * 0.3, L * 0.7, '#5B6064');
  fill(ctx, X + L * 0.6, Y + L * 2.8, S - L * 1.2, L * 1.4, '#8B8F92');
  if (L >= 12) {
    ctx.strokeStyle = '#E6C35C';
    ctx.lineWidth = Math.max(1, L * 0.03);
    ctx.beginPath();
    ctx.moveTo(X + L * 0.6, Y + L * 2.37);
    ctx.lineTo(X + S - L * 0.6, Y + L * 2.37);
    ctx.stroke();
  }
  plane(ctx, X + L * 1.6, Y + L * 3.5, L * 0.9, -Math.PI / 2, '#F5F6F7');
  plane(ctx, X + L * 3.1, Y + L * 3.5, L * 0.9, -Math.PI / 2, '#F5F6F7');
  // Terminal and tower.
  box(dc, X + L * 0.6, Y + L * 4.3, L * 4.2, L * 1.55, L * 0.45, { roof: '#AFB6BC', wall: '#D5DADE', glass: '#5F87A6', rng: r, bands: true, roofBits: 3 });
  box(dc, X + L * 5.05, Y + L * 3.6, L * 0.6, L * 2.2, L * 1.4, { roof: '#6E7880', wall: '#C4CAD0', glass: '#3C5B73', rng: r, bands: true });
  dc.emit?.({ kind: 'beacon', x: (X + L * 5.35) / L, y: (Y + L * 3.75) / L, size: 0.06 });
}

/** Top-down airliner. Also used by the renderer for planes in flight. */
export function plane(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, angle: number, col: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = col;
  const w = len * 0.12;
  ctx.fillRect(-len / 2, -w / 2, len, w);
  ctx.beginPath();
  ctx.moveTo(len * 0.08, 0);
  ctx.lineTo(-len * 0.12, -len * 0.48);
  ctx.lineTo(-len * 0.24, -len * 0.48);
  ctx.lineTo(-len * 0.12, 0);
  ctx.lineTo(-len * 0.24, len * 0.48);
  ctx.lineTo(-len * 0.12, len * 0.48);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-len * 0.38, 0);
  ctx.lineTo(-len * 0.48, -len * 0.18);
  ctx.lineTo(-len * 0.52, -len * 0.18);
  ctx.lineTo(-len * 0.47, 0);
  ctx.lineTo(-len * 0.52, len * 0.18);
  ctx.lineTo(-len * 0.48, len * 0.18);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(len / 2, 0, w / 2, -Math.PI / 2, Math.PI / 2);
  ctx.fill();
  ctx.restore();
}

function drawCoal(dc: DC, X: number, Y: number, r: Rng): void {
  const { ctx, L } = dc;
  const S = L * 4;
  fill(ctx, X, Y, S, S, 'rgba(150,140,124,0.92)');
  // Coal heap.
  ctx.fillStyle = '#2B2926';
  ctx.beginPath();
  ctx.ellipse(X + L * 0.95, Y + L * 3.1, L * 0.75, L * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  if (L >= 12) {
    ctx.fillStyle = '#45423D';
    ctx.beginPath();
    ctx.ellipse(X + L * 0.8, Y + L * 2.95, L * 0.4, L * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  box(dc, X + L * 0.15, Y + L * 0.2, L * 2.3, L * 2.0, L * 0.85, { roof: '#6D6259', wall: '#8C7F72', glass: '#3F3A35', rng: r, bands: true, roofBits: 2 });
  box(dc, X + L * 1.9, Y + L * 2.4, L * 1.9, L * 1.4, L * 0.4, { roof: '#7D8084', wall: '#9EA2A6', windows: false, rng: r });
  smokestack(dc, X + L * 3.0, Y + L * 1.6, L * 0.22, L * 1.5, '#8A7D73');
  smokestack(dc, X + L * 3.55, Y + L * 1.9, L * 0.2, L * 1.4, '#8A7D73');
}

function drawNuclear(dc: DC, X: number, Y: number): void {
  const { ctx, L } = dc;
  const S = L * 4;
  fill(ctx, X, Y, S, S, 'rgba(198,196,188,0.92)');
  const towers: [number, number][] = [[1.0, 1.05], [2.95, 1.05]];
  for (const [tx, ty] of towers) {
    const cx = X + L * tx;
    const cy = Y + L * ty;
    const rad = L * 0.9;
    ctx.fillStyle = 'rgba(18,28,22,0.25)';
    ctx.beginPath();
    ctx.ellipse(cx + rad * 0.35, cy + rad * 0.35, rad, rad, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(cx - rad * 0.45, cy - rad * 0.45, rad * 0.1, cx, cy, rad);
    g.addColorStop(0, '#F2F1EC');
    g.addColorStop(1, '#A7A59E');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
    circle(ctx, cx + rad * 0.05, cy + rad * 0.05, rad * 0.66, '#5C5F60');
    circle(ctx, cx + rad * 0.1, cy + rad * 0.1, rad * 0.5, '#3E4142');
    dc.emit?.({ kind: 'steam', x: cx / L, y: cy / L, size: 0.6 });
  }
  // Containment dome and turbine hall.
  box(dc, X + L * 1.9, Y + L * 2.25, L * 1.95, L * 1.6, L * 0.5, { roof: '#9FA6AC', wall: '#C9CED2', windows: false });
  const dx = X + L * 1.0;
  const dy = Y + L * 3.0;
  ctx.fillStyle = 'rgba(18,28,22,0.25)';
  ctx.beginPath();
  ctx.arc(dx + L * 0.2, dy + L * 0.2, L * 0.72, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(dx - L * 0.3, dy - L * 0.3, L * 0.05, dx, dy, L * 0.72);
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(1, '#9EA3A6');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(dx, dy, L * 0.72, 0, Math.PI * 2);
  ctx.fill();
}

function drawWind(dc: DC, X: number, Y: number): void {
  const { ctx, L } = dc;
  const cx = X + L * 0.5;
  const base = Y + L * 0.88;
  const hub = Y + L * 0.3;
  circle(ctx, cx, base, L * 0.16, 'rgba(180,176,166,0.9)');
  ctx.fillStyle = 'rgba(18,28,22,0.2)';
  ctx.beginPath();
  ctx.moveTo(cx, base);
  ctx.lineTo(cx + L * 0.4, base + L * 0.1);
  ctx.lineTo(cx + L * 0.42, base + L * 0.06);
  ctx.closePath();
  ctx.fill();
  const w = Math.max(1, L * 0.06);
  fill(ctx, cx - w / 2, hub, w, base - hub, '#E9ECEE');
  fill(ctx, cx - w / 2, hub, w * 0.4, base - hub, '#FFFFFF');
  circle(ctx, cx, hub, Math.max(1, L * 0.06), '#DADFE2');
  dc.emit?.({ kind: 'rotor', x: cx / L, y: hub / L, size: 0.42 });
}

function drawSolar(dc: DC, X: number, Y: number): void {
  const { ctx, L } = dc;
  const S = L * 3;
  fill(ctx, X, Y, S, S, 'rgba(170,180,150,0.7)');
  const rows = 6;
  for (let k = 0; k < rows; k++) {
    const y = Y + L * 0.15 + k * ((S - L * 0.3) / rows);
    const h = ((S - L * 0.3) / rows) * 0.62;
    fill(ctx, X + L * 0.15 + L * 0.04, y + L * 0.05, S - L * 0.3, h, 'rgba(0,0,0,0.2)');
    fill(ctx, X + L * 0.15, y, S - L * 0.3, h, '#27405E');
    fill(ctx, X + L * 0.15, y, S - L * 0.3, h * 0.3, '#3C5E86');
    if (L >= 16) {
      ctx.strokeStyle = 'rgba(160,190,220,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = X + L * 0.15; x < X + S - L * 0.15; x += L * 0.22) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + h);
      }
      ctx.stroke();
    }
  }
}

/** A canvas-less context that swallows every call; used to collect emitters. */
export const NULL_CTX: CanvasRenderingContext2D = (() => {
  const handler: ProxyHandler<object> = {
    get: () => noop,
    set: () => true,
  };
  const proxy: unknown = new Proxy({}, handler);
  function noop(): unknown {
    return proxy;
  }
  return proxy as CanvasRenderingContext2D;
})();

/** Chimneys, turbine hubs and beacons for a building, in world tile coordinates. */
export function buildingEmitters(world: World, b: Building): Emitter[] {
  const out: Emitter[] = [];
  const dc: DC = { ctx: NULL_CTX, L: 32, world, emit: (e) => out.push(e) };
  drawBuilding(dc, b);
  return out;
}

export { BUILDINGS };

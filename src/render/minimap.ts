// The overview map in the corner: one pixel per tile, with the view outline.
import { POWER, RAIL, ROAD } from '../defs';
import type { World } from '../world';
import { hex } from './color';
import type { Renderer } from './renderer';

const RES = hex('#3DBE84');
const COM = hex('#5AA6FF');
const IND = hex('#E6A92A');
const CIVIC = hex('#D5D0C4');
const POWERC = hex('#F2C94C');

export class Minimap {
  private base: HTMLCanvasElement;
  private dirty = true;
  private timer = 0;

  constructor(private canvas: HTMLCanvasElement, private renderer: Renderer) {
    this.base = document.createElement('canvas');
  }

  markDirty(): void {
    this.dirty = true;
  }

  private rebuild(world: World): void {
    if (this.base.width !== world.w || this.base.height !== world.h) {
      this.base.width = world.w;
      this.base.height = world.h;
    }
    const ctx = this.base.getContext('2d')!;
    const img = ctx.createImageData(world.w, world.h);
    const d = img.data;
    const field = this.renderer.field;
    for (let i = 0; i < world.n; i++) {
      const o = i * 4;
      let r: number, g: number, b: number;
      if (world.water[i] && !world.net[i]) {
        const dv = field.deep[i];
        r = 111 - dv * 65; g = 179 - dv * 84; b = 207 - dv * 65;
      } else {
        r = field.col[i * 3]; g = field.col[i * 3 + 1]; b = field.col[i * 3 + 2];
        if (world.trees[i]) {
          const k = 0.72 - world.trees[i] * 0.06;
          r *= k * 0.8; g *= k; b *= k * 0.8;
        }
      }
      const id = world.occ[i];
      if (id) {
        const bd = world.buildings.get(id);
        if (bd) {
          const c = bd.kind === 'res' ? RES : bd.kind === 'com' ? COM : bd.kind === 'ind' ? IND :
            bd.kind === 'coal' || bd.kind === 'nuclear' || bd.kind === 'wind' || bd.kind === 'solar' ? POWERC :
            bd.kind === 'park' ? [120, 180, 90] : CIVIC;
          const lift = bd.kind === 'res' || bd.kind === 'com' || bd.kind === 'ind' ? 0.55 + Math.min(1, bd.level / 5) * 0.45 : 1;
          r = c[0] * lift; g = c[1] * lift; b = c[2] * lift;
        }
      } else if (world.net[i] & ROAD) {
        r = 70; g = 72; b = 76;
      } else if (world.net[i] & RAIL) {
        r = 120; g = 96; b = 80;
      } else if (world.net[i] & POWER) {
        r = r * 0.8 + 40; g = g * 0.8 + 30; b *= 0.6;
      }
      if (world.fire[i]) { r = 255; g = 110; b = 20; }
      if (world.rubble[i]) { r = 130; g = 118; b = 104; }
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.dirty = false;
  }

  draw(dt: number): void {
    const r = this.renderer;
    const world = r.world;
    if (!world) return;
    this.timer -= dt;
    if (this.dirty && this.timer <= 0) {
      this.rebuild(world);
      this.timer = 0.5;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    if (this.canvas.width !== Math.round(cw * dpr)) this.canvas.width = Math.round(cw * dpr);
    if (this.canvas.height !== Math.round(ch * dpr)) this.canvas.height = Math.round(ch * dpr);
    const ctx = this.canvas.getContext('2d')!;
    const s = Math.min(this.canvas.width / world.w, this.canvas.height / world.h);
    const ox = (this.canvas.width - world.w * s) / 2;
    const oy = (this.canvas.height - world.h * s) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0E1412';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, ox, oy, world.w * s, world.h * s);
    const a = r.screenToTile(0, 0);
    const b = r.screenToTile(r.cssW, r.cssH);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(1, dpr);
    const x0 = Math.max(0, a.x);
    const y0 = Math.max(0, a.y);
    const x1 = Math.min(world.w, b.x);
    const y1 = Math.min(world.h, b.y);
    ctx.strokeRect(ox + x0 * s, oy + y0 * s, (x1 - x0) * s, (y1 - y0) * s);
  }

  /** Convert a pointer position on the minimap to a tile. */
  toTile(clientX: number, clientY: number): { x: number; y: number } {
    const world = this.renderer.world;
    const rect = this.canvas.getBoundingClientRect();
    const s = Math.min(rect.width / world.w, rect.height / world.h);
    const ox = (rect.width - world.w * s) / 2;
    const oy = (rect.height - world.h * s) / 2;
    return { x: (clientX - rect.left - ox) / s, y: (clientY - rect.top - oy) / s };
  }
}

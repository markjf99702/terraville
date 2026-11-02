// A picture of the city to keep or share: its built-up area (or the whole map) as the game draws it, with its sign in a
// corner, saved as a JPEG.
import { RAIL, ROAD, cityClass, dateLabel, num } from '../defs';
import type { Renderer } from '../render/renderer';
import type { World } from '../world';

/** A picture's longest side and its pixels at most: within a phone's canvas memory, and a JPEG of about 1 MB. */
const MAX_SIDE = 2400;
const MAX_PIXELS = 4_600_000;
/** Tiles of country kept round what is built, and the smallest picture of a small town, in tiles. */
const MARGIN = 4;
const MIN_W = 32;
const MIN_H = 24;
/** The share of the shorter side added below the built-up area for the sign. */
const SIGN_ROOM = 0.14;

export interface Area {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The tiles a picture of the built-up area takes in: every building, road and track, with a margin, and at least a
 * small town's worth of map round it. The whole map when nothing is built.
 */
export function builtArea(world: World): Area {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < world.h; y++) {
    for (let x = 0; x < world.w; x++) {
      const i = y * world.w + x;
      if (!world.occ[i] && !(world.net[i] & (ROAD | RAIL))) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x0 > x1) return { x0: 0, y0: 0, x1: world.w, y1: world.h };
  const grow = (lo: number, hi: number, min: number, size: number): [number, number] => {
    lo -= MARGIN;
    hi += MARGIN + 1;
    const short = min - (hi - lo);
    if (short > 0) {
      lo -= Math.floor(short / 2);
      hi += Math.ceil(short / 2);
    }
    // Kept on the map, sliding back in rather than shrinking where it can.
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > size) { lo -= hi - size; hi = size; }
    return [Math.max(0, lo), Math.min(size, hi)];
  };
  [x0, x1] = grow(x0, x1, MIN_W, world.w);
  [y0, y1] = grow(y0, y1, MIN_H, world.h);
  // Room below for the sign, which takes about a seventh of the picture's shorter side, where the map has it.
  y1 = Math.min(world.h, y1 + Math.ceil(Math.min(x1 - x0, y1 - y0) * SIGN_ROOM));
  return { x0, y0, x1, y1 };
}

/** Pixels a tile in a picture of `w` by `h` tiles: as sharp as the street view, within the size a picture may be. */
export function pictureScale(w: number, h: number): number {
  return Math.max(4, Math.min(32, Math.floor(MAX_SIDE / Math.max(w, h)), Math.floor(Math.sqrt(MAX_PIXELS / (w * h)))));
}

/** The picture's file name: 'Mapleford, May 1949.jpg', with nothing a file name can't hold. */
export function pictureName(name: string, month: number): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Terraville';
  return `${safe}, ${dateLabel(month)}.jpg`;
}

/** The green city sign in the picture's bottom-left corner: the name, and its residents, class and date. */
function drawSign(ctx: CanvasRenderingContext2D, w: number, h: number, name: string, residents: number, month: number): void {
  const k = Math.max(1, Math.min(w, h) / 560);
  const sub = `POP ${num(residents)} • ${cityClass(residents).toUpperCase()} • ${dateLabel(month).toUpperCase()}`;
  const nameFont = `800 ${Math.round(22 * k)}px Overpass, system-ui, sans-serif`;
  const subFont = `700 ${Math.round(12 * k)}px Overpass, system-ui, sans-serif`;
  ctx.font = nameFont;
  const nw = ctx.measureText(name).width;
  ctx.font = subFont;
  ctx.letterSpacing = `${(1.4 * k).toFixed(1)}px`;
  const sw = ctx.measureText(sub).width;
  const padX = 16 * k;
  const bw = Math.min(w - 32 * k, Math.max(nw, sw) + padX * 2);
  const bh = 60 * k;
  const x = 16 * k;
  const y = h - 16 * k - bh;
  const round = (inset: number) => {
    const rx = x + inset, ry = y + inset, rw = bw - inset * 2, rh = bh - inset * 2, r = Math.max(2, 9 * k - inset);
    ctx.beginPath();
    ctx.moveTo(rx + r, ry);
    ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
    ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
    ctx.arcTo(rx, ry + rh, rx, ry, r);
    ctx.arcTo(rx, ry, rx + rw, ry, r);
    ctx.closePath();
  };
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 18 * k;
  ctx.shadowOffsetY = 6 * k;
  ctx.fillStyle = '#0b6e4f';
  round(0);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 1.6 * k;
  round(2.8 * k);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = `${(0.4 * k).toFixed(1)}px`;
  ctx.font = nameFont;
  ctx.fillText(name, x + padX, y + 30 * k, bw - padX * 2);
  ctx.letterSpacing = `${(1.4 * k).toFixed(1)}px`;
  ctx.font = subFont;
  ctx.globalAlpha = 0.92;
  ctx.fillText(sub, x + padX, y + 48 * k, bw - padX * 2);
  ctx.globalAlpha = 1;
  ctx.letterSpacing = '0px';
}

/** A picture of the city as a JPEG: its built-up area, or the whole map, with its sign. Null if it couldn't be drawn. */
export async function cityPicture(renderer: Renderer, world: World, residents: number, whole: boolean): Promise<Blob | null> {
  const a = whole ? { x0: 0, y0: 0, x1: world.w, y1: world.h } : builtArea(world);
  const L = pictureScale(a.x1 - a.x0, a.y1 - a.y0);
  // The sign is lettered in the game's own font, once it has loaded.
  try { await document.fonts?.load('800 22px Overpass'); } catch { /* the fallback will do */ }
  const canvas = renderer.picture(a.x0, a.y0, a.x1, a.y1, L);
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return null;
  drawSign(ctx, canvas.width, canvas.height, world.city.name, residents, world.city.month);
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.88));
  canvas.width = canvas.height = 0;
  return blob;
}

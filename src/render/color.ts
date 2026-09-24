// Tiny colour helpers. Colours are kept as [r, g, b] triples so they can be
// shaded without reparsing strings in hot loops.

export type RGB = [number, number, number];

export function hex(h: string): RGB {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgb(c: RGB, a = 1): string {
  const r = Math.max(0, Math.min(255, Math.round(c[0])));
  const g = Math.max(0, Math.min(255, Math.round(c[1])));
  const b = Math.max(0, Math.min(255, Math.round(c[2])));
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

const cache = new Map<string, string>();

/** Multiply a hex colour's brightness by f (1 = unchanged) and return a CSS string. */
export function shade(h: string, f: number, a = 1): string {
  const key = `${h}|${f.toFixed(3)}|${a}`;
  let s = cache.get(key);
  if (!s) {
    const c = hex(h);
    const t: RGB = f <= 1 ? [c[0] * f, c[1] * f, c[2] * f] : [
      c[0] + (255 - c[0]) * (f - 1),
      c[1] + (255 - c[1]) * (f - 1),
      c[2] + (255 - c[2]) * (f - 1),
    ];
    s = rgb(t, a);
    if (cache.size > 4000) cache.clear();
    cache.set(key, s);
  }
  return s;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Identity colours for the three zone types (validated for colour-blind separation on the UI surface). */
export const ZONE_COLORS = {
  res: '#199e70',
  com: '#3987e5',
  ind: '#c98500',
};

/** Brighter variants for outlines drawn on the map itself. */
export const ZONE_MAP_COLORS = {
  res: '#2fcf8f',
  com: '#5aa6ff',
  ind: '#f2b21b',
};

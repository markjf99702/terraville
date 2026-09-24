// Small deterministic random helpers. Everything procedural in the game
// (terrain, building looks, tree placement) derives from these so that a
// seed always reproduces the same map.

export type Rng = () => number;

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: fast, decent quality, 32-bit state. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless integer hash of up to three coordinates, returns [0, 1). */
export function hash3(x: number, y: number, z = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

const SEED_WORDS = [
  'amber', 'basin', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor', 'inlet', 'juniper',
  'kettle', 'lagoon', 'mesa', 'north', 'orchard', 'prairie', 'quarry', 'ridge', 'summit', 'tundra',
  'upland', 'valley', 'willow', 'yarrow', 'zephyr', 'bluff', 'canyon', 'dune', 'estuary', 'fen',
  'glacier', 'heath', 'isle', 'knoll', 'loch', 'moor', 'oasis', 'pine', 'reef', 'shoal', 'tarn',
];

export function randomSeedName(): string {
  const r = makeRng((Date.now() ^ (Math.random() * 1e9)) >>> 0);
  return `${pick(r, SEED_WORDS)}-${pick(r, SEED_WORDS)}-${randInt(r, 10, 99)}`;
}

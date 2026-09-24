// Turning a drag or click into changes on the map, with prices.
import { BRIDGE_COST, BUILDINGS, BULLDOZE_COST, GRADE_COST, Kind, NET_COST, NET_MAX_SLOPE, POWER, RAIL, ROAD } from './defs';
import { World } from './world';

export type Pt = [number, number];

export interface Plan {
  /** Tiles or building origins the action will touch. */
  tiles: Pt[];
  /** Tiles that cannot be built (shown in red). */
  bad: Pt[];
  cost: number;
  /** Why nothing (or not everything) can be built. */
  reason?: string;
  /** Number of things that will be built. */
  count: number;
  /** Part of the cost spent levelling sloped lots or grading a line. */
  grading?: number;
  /** Graded heights for a road or rail line: [tile index, new height]. */
  heights?: [number, number][];
}

/** An L-shaped path: the longer leg first, like dragging a road in the original. */
export function linePath(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const pts: Pt[] = [];
  const horizFirst = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
  const cx = horizFirst ? x1 : x0;
  const cy = horizFirst ? y0 : y1;
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const dx = Math.sign(bx - ax);
    const dy = Math.sign(by - ay);
    let x = ax;
    let y = ay;
    for (;;) {
      pts.push([x, y]);
      if (x === bx && y === by) break;
      x += dx;
      y += dy;
    }
  };
  seg(x0, y0, cx, cy);
  if (cx !== x1 || cy !== y1) {
    pts.pop();
    seg(cx, cy, x1, y1);
  }
  return pts;
}

function netName(bit: number): 'road' | 'rail' | 'power' {
  return bit === ROAD ? 'road' : bit === RAIL ? 'rail' : 'power';
}

/** Deepest cut or tallest fill, in metres, that automatic grading will make on one tile. */
const MAX_CUT = 30;

/**
 * Plan a road, rail or power line along `path`. Roads and rail only care
 * about the slope along the line itself: a track can run across a hillside.
 * Where the line climbs too steeply it is graded into a smooth ramp, and the
 * earthworks are added to the price.
 */
export function planLine(world: World, bit: number, path: Pt[]): Plan {
  const plan: Plan = { tiles: [], bad: [], cost: 0, count: 0 };
  const name = netName(bit);
  const n = path.length;
  const state: ('new' | 'have' | 'bad' | 'off')[] = new Array(n).fill('off');
  for (let k = 0; k < n; k++) {
    const [x, y] = path[k];
    if (!world.inBounds(x, y)) continue;
    const i = y * world.w + x;
    const why = world.canNet(bit, x, y);
    if (why) {
      state[k] = 'bad';
      plan.reason = why;
      continue;
    }
    if (world.net[i] & bit) {
      state[k] = 'have';
      continue;
    }
    if (world.water[i] && bit !== POWER) {
      // Bridges run straight: no turning while over water.
      const prev = path[k - 1];
      const next = path[k + 1];
      if (prev && next && prev[0] !== next[0] && prev[1] !== next[1]) {
        state[k] = 'bad';
        plan.reason = 'Bridges must be straight';
        continue;
      }
      if (world.net[i] & (bit === ROAD ? RAIL : ROAD)) {
        state[k] = 'bad';
        plan.reason = 'Road and rail cannot share a bridge';
        continue;
      }
    }
    state[k] = 'new';
  }

  const target = new Map<number, number>();
  if (bit !== POWER) {
    const limit = bit === ROAD ? NET_MAX_SLOPE.road : NET_MAX_SLOPE.rail;
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) gradeRun(world, bit, path, run, limit, state, target, plan);
      run = [];
    };
    for (let k = 0; k < n; k++) {
      const [x, y] = path[k];
      const ok = state[k] === 'new' || state[k] === 'have';
      if (ok && !world.water[y * world.w + x]) run.push(k);
      else flush();
    }
    flush();
  }

  for (let k = 0; k < n; k++) {
    const [x, y] = path[k];
    if (state[k] === 'bad') plan.bad.push([x, y]);
    if (state[k] !== 'new') continue;
    plan.tiles.push([x, y]);
    plan.count++;
    plan.cost += world.water[y * world.w + x] ? BRIDGE_COST[name] : NET_COST[name];
  }
  let moved = 0;
  for (const [i, h] of target) moved += Math.abs(world.height[i] - h);
  if (moved > 0.05) {
    plan.grading = Math.round(moved * GRADE_COST);
    plan.cost += plan.grading;
    plan.heights = [...target];
  }
  return plan;
}

/**
 * Give a run of consecutive land tiles a profile whose steps stay within
 * `limit`, touching existing track as little as possible (it is held fixed).
 */
function gradeRun(
  world: World, bit: number, path: Pt[], run: number[], limit: number,
  state: ('new' | 'have' | 'bad' | 'off')[], target: Map<number, number>, plan: Plan,
): void {
  const idx = run.map((k) => path[k][1] * world.w + path[k][0]);
  const h = idx.map((i) => world.height[i]);
  const fixed = run.map((k) => state[k] === 'have');
  const p = h.slice();
  const L = limit * 0.95;
  const m = p.length;
  for (let j = 1; j < m; j++) if (!fixed[j]) p[j] = Math.min(p[j - 1] + L, Math.max(p[j - 1] - L, p[j]));
  for (let j = m - 2; j >= 0; j--) if (!fixed[j]) p[j] = Math.min(p[j + 1] + L, Math.max(p[j + 1] - L, p[j]));
  const what = bit === ROAD ? 'road' : 'track';
  for (let j = 0; j < m; j++) {
    const stepBad = j > 0 && Math.abs(p[j] - p[j - 1]) > limit + 0.01;
    if (Math.abs(p[j] - h[j]) > MAX_CUT || stepBad) {
      if (state[run[j]] === 'new') state[run[j]] = 'bad';
      plan.reason = `Too steep for ${what}, even with grading. Flatten the slope with Level land (L) first`;
      continue;
    }
    if (!fixed[j] && Math.abs(p[j] - h[j]) > 0.01) target.set(idx[j], Math.max(0.4, p[j]));
  }
}

export function applyLine(world: World, bit: number, plan: Plan): void {
  if (plan.heights?.length) {
    let x0 = world.w, y0 = world.h, x1 = 0, y1 = 0;
    for (const [i, h] of plan.heights) {
      world.height[i] = h;
      const x = i % world.w;
      const y = (i / world.w) | 0;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    world.dirty(x0 - 1, y0 - 1, x1 + 1, y1 + 1, true);
  }
  for (const [x, y] of plan.tiles) world.setNet(bit, x, y);
}

/** Zone origins tiling the dragged rectangle, anchored at the drag start. */
export function planZones(world: World, kind: Kind, ax: number, ay: number, bx: number, by: number): Plan {
  const s = BUILDINGS[kind].size;
  const plan: Plan = { tiles: [], bad: [], cost: 0, count: 0 };
  // Anchor so the first zone is centred on where the drag began.
  const ox = ax - Math.floor(s / 2);
  const oy = ay - Math.floor(s / 2);
  const nx = Math.max(1, Math.floor(Math.abs(bx - ax) / s) + 1);
  const ny = Math.max(1, Math.floor(Math.abs(by - ay) / s) + 1);
  const sx = bx >= ax ? 1 : -1;
  const sy = by >= ay ? 1 : -1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = ox + i * s * sx;
      const y = oy + j * s * sy;
      const r = world.canPlace(kind, x, y, true);
      if (r.ok) {
        const grading = Math.round(r.grade * GRADE_COST);
        plan.tiles.push([x, y]);
        plan.count++;
        plan.cost += BUILDINGS[kind].cost + r.clear * BULLDOZE_COST + grading;
        plan.grading = (plan.grading ?? 0) + grading;
      } else {
        plan.bad.push([x, y]);
        plan.reason = r.reason;
      }
    }
  }
  return plan;
}

export function planPlace(world: World, kind: Kind, cx: number, cy: number): Plan {
  const s = BUILDINGS[kind].size;
  const x = cx - Math.floor((s - 1) / 2);
  const y = cy - Math.floor((s - 1) / 2);
  const r = world.canPlace(kind, x, y, true);
  if (!r.ok) return { tiles: [], bad: [[x, y]], cost: 0, count: 0, reason: r.reason };
  const grading = Math.round(r.grade * GRADE_COST);
  return { tiles: [[x, y]], bad: [], cost: BUILDINGS[kind].cost + r.clear * BULLDOZE_COST + grading, count: 1, grading };
}

export function applyBuildings(world: World, kind: Kind, plan: Plan): void {
  for (const [x, y] of plan.tiles) {
    const r = world.canPlace(kind, x, y, true);
    if (!r.ok) continue;
    if (r.grade > 0) world.grade(x, y, BUILDINGS[kind].size);
    world.place(kind, x, y);
  }
}

export function rectTiles(ax: number, ay: number, bx: number, by: number): Pt[] {
  const out: Pt[] = [];
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
}

export function planBulldoze(world: World, rect: Pt[]): Plan {
  const plan: Plan = { tiles: [], bad: [], cost: 0, count: 0 };
  const seen = new Set<number>();
  for (const [x, y] of rect) {
    if (!world.inBounds(x, y)) continue;
    const i = y * world.w + x;
    const id = world.occ[i];
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
      const b = world.buildings.get(id)!;
      plan.tiles.push([x, y]);
      plan.cost += BULLDOZE_COST * b.size * b.size;
      plan.count++;
      continue;
    }
    if (world.net[i] || world.trees[i] || world.rubble[i]) {
      plan.tiles.push([x, y]);
      plan.cost += BULLDOZE_COST;
      plan.count++;
    }
  }
  if (!plan.count) plan.reason = 'Nothing to clear';
  return plan;
}

export function applyBulldoze(world: World, plan: Plan): void {
  for (const [x, y] of plan.tiles) world.bulldoze(x, y);
}

export function planParks(world: World, rect: Pt[]): Plan {
  const plan: Plan = { tiles: [], bad: [], cost: 0, count: 0 };
  for (const [x, y] of rect) {
    const r = world.canPlace('park', x, y, true);
    if (r.ok) {
      const grading = Math.round(r.grade * GRADE_COST);
      plan.tiles.push([x, y]);
      plan.cost += BUILDINGS.park.cost + r.clear * BULLDOZE_COST + grading;
      plan.grading = (plan.grading ?? 0) + grading;
      plan.count++;
    } else {
      plan.bad.push([x, y]);
      plan.reason = r.reason;
    }
  }
  return plan;
}

export function planTrees(world: World, rect: Pt[], price: number): Plan {
  const plan: Plan = { tiles: [], bad: [], cost: 0, count: 0 };
  for (const [x, y] of rect) {
    if (!world.inBounds(x, y)) continue;
    const i = y * world.w + x;
    if (world.water[i] || world.occ[i] || world.net[i] || world.rad[i] || world.trees[i] >= 2) continue;
    plan.tiles.push([x, y]);
    plan.cost += price;
    plan.count++;
  }
  if (!plan.count) plan.reason = 'No open land here';
  return plan;
}

export function applyTrees(world: World, plan: Plan): void {
  for (const [x, y] of plan.tiles) {
    const i = y * world.w + x;
    world.trees[i] = 2;
    world.rubble[i] = 0;
    world.dirty(x, y, x, y);
  }
}

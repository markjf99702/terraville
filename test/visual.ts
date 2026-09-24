// Visual harness: renders a generated map with a scripted city for screenshots.
import { generateTerrain, DEFAULT_TERRAIN } from '../src/terrain';
import { Sim } from '../src/sim';
import { Renderer, Overlay } from '../src/render/renderer';
import { ROAD, POWER, RAIL } from '../src/defs';

const q = new URLSearchParams(location.search);
const world = generateTerrain({ ...DEFAULT_TERRAIN, seed: q.get('seed') ?? 'harbor-pine-42', w: 120, h: 100, style: (q.get('style') as any) ?? 'coast', hills: Number(q.get('hills') ?? 45) });
world.city.founded = true;
world.city.disasters = false;
world.city.funds = 1e6;
const cx = Number(q.get('cx') ?? 60), cy = Number(q.get('cy') ?? 50);
if (q.get('city') !== '0') {
  const x0 = cx - 20, y0 = cy - 16, x1 = cx + 20, y1 = cy + 16;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!world.inBounds(x, y)) continue;
    if ((x - x0) % 4 === 0 || (y - y0) % 4 === 0) { if (!world.canNet(ROAD, x, y)) world.setNet(ROAD, x, y); }
    if ((y - y0) % 4 === 0 && !world.canNet(POWER, x, y)) world.setNet(POWER, x, y);
  }
  for (let x = x0 - 6; x <= x1 + 6; x++) if (world.inBounds(x, y1 + 3) && !world.canNet(RAIL, x, y1 + 3)) world.setNet(RAIL, x, y1 + 3);
  let placed = false;
  for (let tries = 0; tries < 400 && !placed; tries++) {
    const px = x0 - 6 + (tries % 20), py = y0 + Math.floor(tries / 20);
    if (world.canPlace('coal', px, py).ok) { world.place('coal', px, py); placed = true; for (let x = px + 4; x <= x0; x++) if (!world.canNet(POWER, x, py + 1)) world.setNet(POWER, x, py + 1); }
  }
  const kinds = ['res', 'res', 'com', 'res', 'ind', 'res', 'com', 'res', 'res', 'ind'] as const;
  let k = 0;
  for (let by = y0 + 1; by + 3 <= y1; by += 4) for (let bx = x0 + 1; bx + 3 <= x1; bx += 4) {
    const kind = kinds[k++ % kinds.length];
    if (world.canPlace(kind, bx, by).ok) world.place(kind, bx, by);
  }
}
const sim = new Sim(world);
const months = Number(q.get('months') ?? 60);
for (let m = 0; m < months * 4; m++) sim.step();
// Force a spread of densities for the screenshot.
if (q.get('levels') === '1') {
  let n = 0;
  for (const b of world.buildings.values()) {
    if (b.kind === 'res') world.setLevel(b, n++ % 9);
    else if (b.kind === 'com') world.setLevel(b, n++ % 6);
    else if (b.kind === 'ind') world.setLevel(b, n++ % 5);
  }
}
const extra = q.get('extra');
if (extra) {
  const kinds = extra.split(',') as any[];
  let ex = cx - 20, ey = cy + 22;
  for (const kind of kinds) {
    for (let t = 0; t < 60; t++) { const x = ex + (t % 12) * 2, y = ey + Math.floor(t / 12); if (world.canPlace(kind, x, y).ok) { world.place(kind, x, y); ex = x + 7; break; } }
  }
}
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh';
document.body.style.margin = '0';
document.body.appendChild(canvas);
const r = new Renderer(canvas);
r.setWorld(world, sim);
r.resize();
r.cam.zoom = Number(q.get('zoom') ?? 16);
r.cam.x = Number(q.get('x') ?? cx);
r.cam.y = Number(q.get('y') ?? cy);
r.contours = q.get('contours') === '1';
r.running = true;
r.setOverlay((q.get('overlay') as Overlay) ?? 'none');
let last = performance.now();
let frames = 0;
function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  r.frame(dt);
  frames++;
  if (frames === 40) (window as any).__ready = true;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
(window as any).__stats = () => ({ pop: sim.stats.residents, funds: world.city.funds });

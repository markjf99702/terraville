// The strategy guide: how Terraville's rules work and how to use them.
// Tables pull from the game's own data so the numbers cannot drift, and the
// pictures are drawn with the game's renderer.
import {
  AUTO_GRADE, BRIDGE_COST, BUILDINGS, CITY_CLASSES, GRADE_COST, Kind, NET_COST, NET_MAX_SLOPE, NET_UPKEEP, POWER, ROAD,
  ZONE_LV_GATE, ZONE_POP,
} from '../defs';
import { DC, drawBuilding, drawNet, drawTrees } from '../render/sprites';
import { TerrainField, paintTerrain } from '../render/terrainPaint';
import { zoneTitle } from '../sim';
import { World } from '../world';

const money = (n: number) => '$' + Math.round(n).toLocaleString();
const acre = (lv: number) => (lv ? `needs ${money(lv * 40)}/acre` : 'no minimum');

interface Section {
  id: string;
  title: string;
  html: string;
}

function table(head: string[], rows: (string | number)[][], numCols: number[] = []): string {
  const cell = (v: string | number, k: number, tag: 'td' | 'th') => `<${tag}${numCols.includes(k) ? ' class="num"' : ''}>${v}</${tag}>`;
  return `<div class="tablewrap"><table class="ledger">
    <tr>${head.map((h, k) => cell(h, k, 'th')).join('')}</tr>
    ${rows.map((r) => `<tr>${r.map((v, k) => cell(v, k, 'td')).join('')}</tr>`).join('')}
  </table></div>`;
}

const tip = (text: string) => `<p class="tip"><span class="caution" aria-hidden="true"></span><span>${text}</span></p>`;

function sections(): Section[] {
  const b = BUILDINGS;
  const plants: Kind[] = ['coal', 'nuclear', 'wind', 'solar'];
  const civic: [Kind, string][] = [
    ['police', 'Cuts crime within about 18 tiles'],
    ['fire', 'Prevents and fights fires within about 18 tiles'],
    ['school', 'Raises land value within about 15 tiles'],
    ['hospital', 'Raises land value within about 18 tiles'],
    ['park', 'Raises land value nearby, soaks up a little pollution'],
    ['stadium', 'Needed before housing passes 18,000 residents'],
    ['airport', 'Needed before commerce passes 5,000 jobs'],
    ['seaport', 'Needed before industry passes 4,000 jobs. Must touch water'],
  ];
  return [
    {
      id: 'start',
      title: 'The first ten minutes',
      html: `
        <p>Every city starts the same way: power, a few lots of each kind, roads between them, and wires to the lots. Pause first (<kbd>Space</kbd>) so nothing happens until you are ready.</p>
        <ol class="steps">
          <li><b>Build a coal plant.</b> It costs ${money(b.coal.cost)} and makes ${b.coal.capacity} MW, enough for about ${Math.floor(b.coal.capacity! / 9)} lots. Put it at the edge of where the town will go, because it pollutes heavily.</li>
          <li><b>Lay a road spine</b> through open, gentle ground. Roads every 7 tiles leave room for a 2×2 block of lots, and every lot in the block touches a road.</li>
          <li><b>Zone a mix.</b> Start with about four residential lots, two industrial and one or two commercial. Keep industry at least a block away from the houses.</li>
          <li><b>Run a power line</b> from the plant to the nearest lot. Lots that touch each other pass power along, so one wire can feed a whole block.</li>
          <li><b>Unpause.</b> Watch the RCI meter at the top and zone more of whatever bar is tallest.</li>
        </ol>
        <figure class="scene" data-scene="starter"><figcaption>A starter town: a coal plant wired into the grid along the top road, homes, a shop and a park inside two blocks, and industry across the road to the south, away from the lake.</figcaption></figure>
        ${tip('A lot flashing a lightning bolt has no power. The fix is almost always a short power line, because power does not travel along roads.')}`,
    },
    {
      id: 'growth',
      title: 'Why lots grow, or don’t',
      html: `
        <p>A lot develops only when all four of these hold:</p>
        <ul>
          <li><b>Power.</b> Unpowered lots never grow, and built ones empty out.</li>
          <li><b>A road touching the lot</b> on at least one side. A corner touching diagonally does not count.</li>
          <li><b>A commute.</b> Homes need to reach a shop or factory, and shops and factories need to reach homes, within about 80 road tiles.</li>
          <li><b>Demand.</b> The matching bar on the RCI meter has to be above the line, and local conditions have to be decent.</li>
        </ul>
        <p>Growth is gradual. Each month a qualifying lot has a small chance to go up one density level, and a better score raises that chance. Pick <b>Inspect</b> (<kbd>Q</kbd>) and click a lot to see its density, residents or jobs, and any problem such as “No road access” or “Commute too long”.</p>
        <p>What counts as a good spot differs by zone:</p>
        <ul>
          <li><b>Homes</b> want high land value, clean air, low crime, and schools or hospitals nearby.</li>
          <li><b>Shops</b> want land value and low crime, and put up with some pollution.</li>
          <li><b>Industry</b> prefers cheap land and ignores pollution. It is happiest on the unloved side of town.</li>
        </ul>`,
    },
    {
      id: 'demand',
      title: 'The RCI meter',
      html: `
        <p>The three bars at the top show demand for residential, commercial and industrial space. Bars above the line mean people want more of that zone. Bars below mean there is too much.</p>
        <p>Demand follows simple ratios:</p>
        <ul>
          <li><b>Residents follow jobs.</b> Each job supports about two residents.</li>
          <li><b>Commerce follows people.</b> Shops and offices want roughly one job for every four or five residents.</li>
          <li><b>Industry exports.</b> Factories want about three jobs for every ten residents.</li>
        </ul>
        <p>Taxes push all three bars at once. Each point above 7% pulls them down, and each point below pushes them up.</p>
        <p>Three limits stop a city cold until you build the landmark it needs, and the news ticker tells you when you hit one:</p>
        ${table(['Limit', 'Needs'], [
          ['Housing past 18,000 residents', 'Stadium'],
          ['Commerce past 5,000 jobs', 'Airport'],
          ['Industry past 4,000 jobs', 'Seaport, touching water'],
        ])}
        ${tip('If a bar is high but nothing grows, check the lots rather than the meter: power, a touching road, and the commute.')}`,
    },
    {
      id: 'density',
      title: 'Density and land value',
      html: `
        <p>How tall a lot can grow depends on its land value, which the Inspect tool shows in dollars per acre. Cheap land stays low-rise no matter how high demand gets.</p>
        <div class="ladder" data-ladder="res"></div>
        <div class="ladder" data-ladder="com"></div>
        <div class="ladder" data-ladder="ind"></div>
        <p>For housing, schools and hospitals nearby count for up to $1,200/acre towards these thresholds. Industry has no land value threshold and tops out at level 4.</p>
        <p>Land value builds up from:</p>
        ${table(['Raises it', 'Up to'], [
          ['Water within 6 tiles', '+$1,680'],
          ['Being close to the centre of town', '+$1,920'],
          ['Parks nearby', '+$1,600'],
          ['Schools and hospitals nearby', '+$2,240'],
          ['Hills and high ground', '+$960'],
          ['Trees nearby', '+$880'],
        ], [1])}
        <p>Pollution is the big one on the other side: every point of it costs more than crime or traffic does. A lot next to heavy industry can lose most of its value.</p>
        ${tip('Parks cost $10 each. A few parks around a residential block can lift it past a density threshold for less than the price of one zone.')}`,
    },
    {
      id: 'power',
      title: 'Power',
      html: `
        ${table(['Plant', 'Cost', 'Output', 'Upkeep', 'Notes'], plants.map((k) => [
          b[k].name,
          money(b[k].cost),
          `${b[k].capacity} MW`,
          `${money(b[k].upkeep)}/mo`,
          k === 'coal' ? 'Heavy pollution' : k === 'nuclear' ? 'Clean, rare meltdown risk' : k === 'wind' ? '1×1, fine on hilltops' : 'Clean and quiet',
        ]), [1, 2, 3])}
        <ul>
          <li>Every tile of every building draws 1 MW, so a 3×3 lot needs 9 MW even while it is still vacant.</li>
          <li>Power flows through power lines and through buildings that touch, except parks. Roads and rail do not carry it. You can string a power line along an existing road.</li>
          <li>The grid updates the moment you build, even while paused. A flashing bolt on a lot means no power reaches it yet.</li>
          <li>When demand outruns supply, the lots furthest from the plants go dark first. The news ticker warns about brownouts.</li>
        </ul>
        ${tip('Build the next plant when demand reaches about 80% of supply. The Report shows both numbers.')}`,
    },
    {
      id: 'traffic',
      title: 'Roads, rail and traffic',
      html: `
        ${table(['', 'Cost per tile', 'Bridge', 'Upkeep', 'Steepest step it climbs'], [
          ['Road', money(NET_COST.road), money(BRIDGE_COST.road), `$${NET_UPKEEP.road}/mo`, `${NET_MAX_SLOPE.road} m`],
          ['Rail', money(NET_COST.rail), money(BRIDGE_COST.rail), `$${NET_UPKEEP.rail}/mo`, `${NET_MAX_SLOPE.rail} m`],
          ['Power line', money(NET_COST.power), money(BRIDGE_COST.power), 'free', 'any'],
        ], [1, 2, 3, 4])}
        <p>Residents spread their commutes over the city’s biggest employers, so traffic piles up on the roads leading downtown and into the industrial district. Busy roads add pollution and lower nearby land value, and jammed roads make commutes slower, which spreads traffic onto parallel streets.</p>
        <ul>
          <li><b>Rail</b> is cheaper to travel on than any road, and trips by rail add no cars. Link rail to the road network at both ends and it pulls commuters off the busiest streets. Lots still need a road touching them to grow.</li>
          <li><b>Mixed zoning</b> shortens commutes. A pocket of commercial lots inside a residential district keeps many trips off the main roads.</li>
          <li><b>Parallel roads</b> share the load. One long arterial carrying everything will jam.</li>
        </ul>
        ${tip('Turn on the Traffic layer to see which roads are jammed before you build anything to fix them.')}`,
    },
    {
      id: 'money',
      title: 'Money',
      html: `
        <p>Taxes arrive monthly. Every resident pays, jobs count for 70% of a resident, and the total is scaled by the city’s average land value. A city of valuable land collects up to 2.6 times as much per person as a cheap one, so raising land value is the best way to raise revenue.</p>
        <ul>
          <li><b>7%</b> keeps demand neutral. Residents start to grumble about taxes above about 12%, and every point above 7% slows growth.</li>
          <li><b>Upkeep</b> is charged monthly: roads and rail by the tile, police and fire by the station (scaled by their funding), and each plant and service building.</li>
          <li><b>Loans</b> come in $10,000 steps up to $30,000 at 7% a year. They are worth it to fund a plant or a landmark that unlocks growth, not to cover running costs.</li>
          <li><b>Underfunding</b> police or fire weakens their reach. Cutting roads and rail below 90% makes tiles crumble into rubble every month.</li>
        </ul>
        ${tip('The Budget pauses the game and shows last month and the year so far line by line. The History charts show whether income is keeping up with spending.')}`,
    },
    {
      id: 'services',
      title: 'Services and landmarks',
      html: `
        ${table(['Building', 'Cost', 'Upkeep', 'What it does'], civic.map(([k, what]) => [
          b[k].name, money(b[k].cost), b[k].upkeep < 1 ? `$${b[k].upkeep}/mo` : `${money(b[k].upkeep)}/mo`, what,
        ]), [1, 2])}
        <p>Crime grows where people are crowded and land is cheap. Police coverage cancels it out, so place stations in dense, low-value neighbourhoods first. Service buildings need power too; an unpowered station works at about a third of its strength.</p>
        ${tip('Turn on the Police reach, Fire cover or Schools & health layer to find the gaps in coverage.')}`,
    },
    {
      id: 'terrain',
      title: 'Building on hills',
      html: `
        <ul>
          <li><b>Zones and buildings</b> level their own lot when the ground is moderately sloped, up to ${AUTO_GRADE} times their normal limit. The cursor price includes the earthworks.</li>
          <li><b>Roads and rail</b> only care about the slope along the line, so they can run across a hillside freely. Where they climb too steeply they cut themselves a ramp, also priced in.</li>
          <li><b>Level land</b> (<kbd>L</kbd>) is for anything steeper. Hold it over the slope and it flattens toward the height where you first pressed, at ${money(GRADE_COST)} per metre of earth moved. Selecting it turns on the Steepness layer, and the cursor shows the steepness underneath.</li>
        </ul>
        ${tip('High ground adds land value, and so does a view of water. A gentle hillside above a lake is prime residential land.')}`,
    },
    {
      id: 'disasters',
      title: 'Disasters',
      html: `
        <p>Random disasters start once a city passes 400 residents, and can be switched off from the Disasters menu. Harder difficulties bring them more often.</p>
        ${table(['Disaster', 'How to prepare'], [
          ['Fire', 'The most common by far. Fire stations prevent fires and put them out. Buildings far from a station catch fire more often, and fire spreads through trees and touching buildings. Bulldoze a gap to stop it.'],
          ['Flood', 'Starts on low shoreline and spreads over land a few metres above the water. Keep valuable buildings on higher ground.'],
          ['Tornado', 'Wanders near the town centre. You cannot stop it, so keep money in reserve to rebuild.'],
          ['Earthquake', 'Wrecks buildings and roads within about 16 tiles and starts fires. Good fire cover limits the damage.'],
          ['Monster', 'Appears only when pollution is high, comes out of the water, and heads for the most polluted spot. Clean air keeps it away.'],
          ['Meltdown', 'Only with a nuclear plant: a small chance each month, or if the plant is destroyed. It contaminates the area for years.'],
        ])}
        ${tip('Every message in the news ticker with a location has a Go there button.')}`,
    },
    {
      id: 'challenges',
      title: 'Challenges',
      html: `
        ${table(['Challenge', 'How to approach it'], [
          ['Boomtown', 'Money is tight. Build one coal plant, lay roads every 7 tiles to save asphalt, and grow in step with the RCI meter. Twelve thousand residents needs roughly six thousand jobs.'],
          ['Gridlock', 'Run rail from the outer housing into downtown, add parallel roads beside the jammed ones, and zone pockets of commerce inside the residential rings. Keep at least 30,000 people while you do it.'],
          ['Smog Valley', 'The coal plants are the worst polluters. Replace them with nuclear, solar or wind, plant trees and parks between the factories and the homes, and bulldoze the industry that sits closest to houses.'],
          ['Aftershock', 'Put the fires out first: check fire cover and bulldoze firebreaks. Then clear rubble, reconnect roads and power, and push land value up with hospitals and schools to reach 55,000.'],
          ['Monster Bay', 'The monster returns about every two years and makes for the smoke, which here means the coal plants. Switch to clean power, keep fire cover up for the fires it starts, and keep taxes near 7% to hold approval above 60%.'],
        ])}`,
    },
    {
      id: 'classes',
      title: 'City sizes',
      html: `${table(['Class', 'Residents'], CITY_CLASSES.map((c) => [c.name, c.min ? `${c.min.toLocaleString()}+` : 'under 2,000']), [1])}`,
    },
  ];
}

// ---- pictures ------------------------------------------------------------

function renderWorld(world: World, L: number): HTMLCanvasElement {
  const field = new TerrainField(world);
  const CS = Math.max(world.w, world.h);
  const off = document.createElement('canvas');
  off.width = off.height = CS * L;
  const ctx = off.getContext('2d');
  const out = document.createElement('canvas');
  out.width = world.w * L;
  out.height = world.h * L;
  if (!ctx) return out;
  ctx.putImageData(paintTerrain(ctx, field, world, 0, 0, CS, L, false), 0, 0);
  const dc: DC = { ctx, L, world };
  for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w; x++) if (!world.occ[y * world.w + x] && world.trees[y * world.w + x]) drawTrees(dc, x, y);
  for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w; x++) if (world.net[y * world.w + x]) drawNet(dc, x, y);
  const list = [...world.buildings.values()].sort((a, c) => a.y + a.size - (c.y + c.size));
  for (const bd of list) drawBuilding(dc, bd);
  out.getContext('2d')?.drawImage(off, 0, 0);
  return out;
}

function starterWorld(): World {
  const w = new World(22, 12);
  w.height.fill(3);
  for (let y = 0; y < w.h; y++) {
    for (let x = 20; x < w.w; x++) {
      w.water[y * w.w + x] = 1;
      w.height[y * w.w + x] = -2;
    }
  }
  for (let y = 9; y < 12; y++) for (let x = 13; x < 19; x++) w.trees[y * w.w + x] = 1 + ((x * 7 + y * 3) % 3);
  const road = (x0: number, y0: number, x1: number, y1: number, bits = ROAD) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) w.net[y * w.w + x] |= bits;
  };
  road(5, 1, 19, 1, ROAD | POWER);
  road(5, 8, 19, 8);
  road(5, 1, 5, 11);
  road(12, 1, 12, 8);
  road(19, 1, 19, 8);
  road(4, 1, 4, 1, POWER);
  w.place('coal', 0, 1, 11);
  const zone = (k: Kind, x: number, y: number, level: number, seed: number) => w.setLevel(w.place(k, x, y, seed), level);
  zone('res', 6, 2, 3, 21);
  zone('res', 9, 2, 4, 5);
  zone('res', 6, 5, 2, 8);
  zone('com', 9, 5, 2, 13);
  zone('res', 13, 2, 5, 17);
  zone('res', 16, 2, 4, 3);
  zone('res', 13, 5, 3, 29);
  for (let y = 5; y < 8; y++) for (let x = 16; x < 19; x++) w.place('park', x, y, x * 3 + y);
  zone('ind', 6, 9, 3, 41);
  zone('ind', 9, 9, 2, 43);
  return w;
}

function lotCanvas(kind: 'res' | 'com' | 'ind', level: number, L: number): HTMLCanvasElement {
  const w = new World(3, 3);
  w.height.fill(3);
  const b = w.place(kind, 0, 0, 1000 + level * 37 + kind.length);
  w.setLevel(b, level);
  return renderWorld(w, L);
}

function fillPictures(root: HTMLElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scene = root.querySelector<HTMLElement>('[data-scene="starter"]');
  if (scene) {
    const c = renderWorld(starterWorld(), 20 * dpr);
    c.style.width = '100%';
    c.style.maxWidth = '660px';
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', 'A starter town with a coal plant, roads, homes, a shop, a park and industry');
    scene.prepend(c);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-ladder]')) {
    const kind = el.dataset.ladder as 'res' | 'com' | 'ind';
    const label = kind === 'res' ? 'Residential' : kind === 'com' ? 'Commercial' : 'Industrial';
    el.innerHTML = `<div class="ladder-title">${label}</div><div class="ladder-row"></div>`;
    const row = el.querySelector('.ladder-row')!;
    for (let level = 1; level < ZONE_POP[kind].length; level++) {
      const fig = document.createElement('figure');
      const c = lotCanvas(kind, level, 16 * dpr);
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', zoneTitle(kind, level));
      fig.appendChild(c);
      const cap = document.createElement('figcaption');
      const pop = ZONE_POP[kind][level].toLocaleString();
      cap.innerHTML = `<b>${zoneTitle(kind, level)}</b><span class="num">${pop} ${kind === 'res' ? 'residents' : 'jobs'}</span><span class="num">${acre(ZONE_LV_GATE[kind][level])}</span>`;
      fig.appendChild(cap);
      row.appendChild(fig);
    }
  }
}

/** The guide's content: a section list beside a scrolling article. */
export function buildGuide(): HTMLElement {
  const list = sections();
  const root = document.createElement('div');
  root.className = 'guide';
  root.innerHTML = `
    <nav class="guide-nav" aria-label="Guide sections">${list.map((s) => `<button data-go="${s.id}">${s.title}</button>`).join('')}</nav>
    <article class="guide-body">${list.map((s) => `<section id="guide-${s.id}"><h3>${s.title}</h3>${s.html}</section>`).join('')}</article>`;
  fillPictures(root);
  root.querySelector('.guide-nav')!.addEventListener('click', (e) => {
    const bt = (e.target as HTMLElement).closest<HTMLElement>('[data-go]');
    if (!bt) return;
    root.querySelector(`#guide-${bt.dataset.go}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return root;
}

/** Highlight the section in view; call once the guide is inside its scrolling container. */
export function trackGuide(root: HTMLElement, scroller: HTMLElement): void {
  const buttons = [...root.querySelectorAll<HTMLElement>('[data-go]')];
  const secs = [...root.querySelectorAll<HTMLElement>('.guide-body section')];
  const update = () => {
    const top = scroller.getBoundingClientRect().top + 60;
    let current = secs[0]?.id;
    for (const s of secs) if (s.getBoundingClientRect().top <= top) current = s.id;
    for (const bt of buttons) bt.setAttribute('aria-current', String(`guide-${bt.dataset.go}` === current));
  };
  scroller.addEventListener('scroll', update, { passive: true });
  update();
}

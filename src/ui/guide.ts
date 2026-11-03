// The strategy guide: how Terraville's rules work and how to use them.
// Tables pull from the game's own data so the numbers cannot drift, and the
// pictures are drawn with the game's renderer.
import {
  AUTO_GRADE, BRIDGE_COST, BUILDINGS, CITY_CLASSES, DISASTER_POP, DOES, GIFT_LV, GIFT_REACH, GRADE_COST, Kind, LANDMARK_LIMITS, NET_COST,
  NET_MAX_SLOPE, NET_UPKEEP, POWER, ROAD, STATION_POP, UPGRADES, UPGRADE_LV, ZONE_LV_GATE, ZONE_POP, isGift, num,
} from '../defs';
import { lessMotion } from '../motion';
import { DC, drawBuilding, drawNet, drawTrees } from '../render/sprites';
import { TerrainField, paintTerrain } from '../render/terrainPaint';
import { zoneTitle } from '../sim';
import { World } from '../world';

const money = (n: number) => '$' + num(n);
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
  const civic: [Kind, string][] = (['police', 'fire', 'school', 'hospital', 'park', 'stadium', 'airport', 'seaport', 'mayor'] as const)
    .map((k) => [k, DOES[k]]);
  return [
    {
      id: 'start',
      title: 'The first ten minutes',
      html: `
        <p>Every city starts the same way: power, a few lots of each kind, roads between them, and wires to the lots. A new city starts paused, so nothing happens until you are ready.</p>
        <ol class="steps">
          <li><b>Build a coal plant.</b> It costs ${money(b.coal.cost)} and makes ${num(b.coal.capacity!)} MW, enough for about ${Math.floor(b.coal.capacity! / 9)} lots. Put it at the edge of where the town will go, because it pollutes heavily. On Hard, a few wind turbines (${money(b.wind.cost)} each) are the safer start: a coal plant’s upkeep outruns a small town’s taxes.</li>
          <li><b>Lay a road spine</b> through open, gentle ground. Roads every 7 tiles leave room for a 2×2 block of lots, and every lot in the block touches a road.</li>
          <li><b>Zone a mix.</b> Start with about four residential lots, two industrial and one or two commercial. Keep industry at least a block away from the houses.</li>
          <li><b>Run a power line</b> from the plant to the nearest lot. Lots that touch each other pass power along, so one wire can feed a whole block, but not across a road: give each block its own short wire, or run one line along the road past them.</li>
          <li><b>Press play</b> (or <kbd>Space</kbd>). Watch the RCI meter at the top and zone more of whatever bar is tallest.</li>
        </ol>
        <figure class="scene" data-scene="starter"><figcaption>A starter town: a coal plant wired into the grid along the top road, homes, a shop and a park inside two blocks, and industry across the road to the south, away from the lake.</figcaption></figure>
        ${tip('A lot flashing a lightning bolt has no power. The fix is almost always a short power line, because power does not travel along roads.')}`,
    },
    {
      id: 'growth',
      title: 'Why lots grow, or don’t',
      html: `
        <p>A lot develops only when all three of these hold:</p>
        <ul>
          <li><b>Power.</b> Unpowered lots never grow, and built ones empty out.</li>
          <li><b>A road touching the lot</b> on at least one side. A corner touching diagonally does not count.</li>
          <li><b>A commute.</b> Homes need to reach a shop or factory, and shops and factories need to reach homes, within about 80 road tiles.</li>
        </ul>
        <p>Then <b>demand</b> and local conditions decide how fast it grows. With the matching bar on the RCI meter above the line, lots in decent spots fill in. Below the line, lots in the best spots still grow, only more slowly, and poor ones start to empty out.</p>
        <p>Growth is gradual. Each month a qualifying lot has a small chance to go up one density level, and the better its spot, the higher that chance. Pick <b>Inspect</b> (<kbd>Q</kbd>) and click a lot to see its density, residents or jobs, any problem such as “No road access” or “Commute too long”, how dense it can grow where it stands, and its outlook.</p>
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
        <p>The three bars at the top show demand for residential, commercial and industrial space. Bars above the line mean people want more of that zone. Bars below mean there is too much. Tap or click the meter to have each bar put in words.</p>
        <p>Demand follows simple ratios:</p>
        <ul>
          <li><b>Residents follow jobs.</b> Each job supports about two residents.</li>
          <li><b>Commerce follows people.</b> Shops and offices want roughly one job for every four or five residents.</li>
          <li><b>Industry exports.</b> Factories want about three jobs for every ten residents.</li>
        </ul>
        <p>Taxes push all three bars at once. Each point above 7% pulls them down, and each point below pushes them up.</p>
        <p>Three limits stop a city cold until you build the landmark it needs, and the news ticker tells you when you hit one:</p>
        ${table(['Limit', 'Needs'], [
          [`Housing past ${num(LANDMARK_LIMITS.res)} residents`, 'Stadium'],
          [`Commerce past ${num(LANDMARK_LIMITS.com)} jobs`, 'Airport'],
          [`Industry past ${num(LANDMARK_LIMITS.ind)} jobs`, 'Seaport, touching water'],
        ])}
        ${tip('If a bar is high but nothing grows, check the lots rather than the meter: power, a touching road, the commute, and land value: Inspect shows the most a lot can grow where it stands, and what holds it back.')}`,
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
          ['Parks nearby', '+$1,100'],
          ['Schools and hospitals nearby', '+$2,240'],
          ['Hills and high ground', '+$960'],
          ['Trees nearby', '+$880'],
          ['Landmark upgrades, all six', `+${money(6 * UPGRADE_LV * 40)}`],
        ], [1])}
        <p>Pollution is the big one on the other side: every point of it costs more than crime or traffic does. A lot next to heavy industry can lose most of its value.</p>
        ${tip('Parks cost $10 each. A ring of them around a block adds a few hundred dollars an acre, enough to tip a lot that is just short of a threshold. A school or hospital nearby does far more.')}`,
    },
    {
      id: 'power',
      title: 'Power',
      html: `
        ${table(['Plant', 'Cost', 'Output', 'Upkeep', 'Notes'], plants.map((k) => [
          b[k].name,
          money(b[k].cost),
          `${num(b[k].capacity!)} MW`,
          `${money(b[k].upkeep)}/mo`,
          k === 'coal' ? 'Heavy pollution' : k === 'nuclear' ? 'Clean, rare meltdown risk' : k === 'wind' ? '1×1, fine on hilltops' : 'Clean and quiet',
        ]), [1, 2, 3])}
        <ul>
          <li>Every tile of every building draws 1 MW, so a 3×3 lot needs 9 MW even while it is still vacant.</li>
          <li>Power flows through power lines and through buildings that touch, except parks. Roads and rail do not carry it. You can string a power line along an existing road.</li>
          <li>The grid updates the moment you build, even while paused. A flashing bolt on a lot means no power reaches it yet.</li>
          <li>When a grid needs more than its plants make, the lots furthest from its plants go dark first. The news ticker warns about brownouts.</li>
          <li>Plants only share power within one connected grid. Two plants on grids that never touch can leave one short while the other has plenty spare, even when the Report's city-wide total looks fine. The Power grid layer shows overloaded grids in orange, and Inspect on any lot or line gives its grid's load.</li>
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
          <li><b>Rail</b> is cheaper to travel on than any road, and trips by rail add no cars. Link rail to the road network at both ends and it pulls commuters off the busiest streets. A street can cross the track: trains pass through without adding cars. Lots that touch a rail line put their commuters straight on the train, though they still need a road touching them to grow.</li>
          <li><b>Mixed zoning</b> shortens commutes. A pocket of commercial lots inside a residential district keeps many trips off the main roads.</li>
          <li><b>Parallel roads</b> share the load. One long arterial carrying everything will jam.</li>
        </ul>
        ${tip('Turn on the Traffic layer to see which roads are jammed before you build anything to fix them. It shades the track by its riders too, in blue: a line nobody rides stays faint, and busy lines run more trains, and longer ones. Inspect on a road or a tile of track says how many commuters pass along it, from where to where, and can show their homes and work on the map.')}`,
    },
    {
      id: 'money',
      title: 'Money',
      html: `
        <p>Taxes arrive monthly. Every resident pays, jobs count for 70% of a resident, and the total is scaled by the city’s average land value. A city of valuable land collects up to 2.6 times as much per person as a cheap one, so raising land value is the best way to raise revenue.</p>
        <ul>
          <li><b>7%</b> keeps demand neutral, and nobody minds it. Every point above it slows growth, and from 9% taxes are among the worries in the city report: Minor at first, Serious from 11% and Severe from 14%. Going below 7% lifts demand but wins no approval.</li>
          <li><b>Upkeep</b> is charged monthly: roads and rail by the tile, police and fire by the station (scaled by their funding), and each plant and service building.</li>
          <li><b>Loans</b> come in $10,000 steps up to $30,000 at 7% a year. They are worth it to fund a plant or a landmark that unlocks growth, not to cover running costs.</li>
          <li><b>In debt</b> nothing new can be built, but bulldozing still works at $1 a tile, so you can clear away what the city can’t afford to run. After a year in debt a card says which costs are biggest, the tax rate that would cover them, and what the Budget can still lend.</li>
          <li><b>Underfunding</b> police or fire weakens their reach. Cutting roads and rail below 90% makes tiles crumble into rubble every month.</li>
          <li><b>A sandbox city</b>, the fourth choice in Found a new city, charges nothing: funds read Unlimited and everything builds. It plays as Medium, landmark limits and all, and its Budget still shows what taxes would bring in and the city would cost, with no loans. Random disasters start switched off, the report gives no score, the year’s paper says nothing of money, and a sandbox stays a sandbox.</li>
        </ul>
        ${tip('The Budget pauses the game and shows last month and the year so far line by line. The History charts show whether income is keeping up with spending.')}`,
    },
    {
      id: 'services',
      title: 'Services and landmarks',
      html: `
        ${table(['Building', 'Cost', 'Upkeep', 'What it does'], civic.map(([k, what]) => [
          b[k].name, isGift(k) ? 'Free, a gift' : money(b[k].cost), !b[k].upkeep ? 'None' : b[k].upkeep < 1 ? `$${b[k].upkeep}/mo` : `${money(b[k].upkeep)}/mo`, what,
        ]), [1, 2])}
        <p>Crime grows where people are crowded and land is cheap. Police coverage cancels it out, so place stations in dense, low-value neighbourhoods first. Service buildings need power too; an unpowered station works at about a third of its strength.</p>
        <p>Once a city has money to spare, each landmark can be upgraded twice from its Inspect card. Every upgrade raises land value across the whole city by ${money(UPGRADE_LV * 40)}/acre, so homes and shops can grow denser and taxes bring in more, but they cost a lot and add to the upkeep. Only the most upgraded stadium, seaport and airport count, so upgrading a second one adds nothing.</p>
        ${table(['Landmark', 'First upgrade', 'Second upgrade'], (['stadium', 'seaport', 'airport'] as Kind[]).map((k) => [
          b[k].name, ...UPGRADES[k]!.map((u) => `${u.name}<br>${money(u.cost)}, +${money(u.upkeep)}/mo`),
        ]))}
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
          <li><b>In the terrain editor</b>, the lines under the sliders say how much of the map is flat for building (dry land a zone's lot fits on without levelling), how much of the land is one landmass, and how many rivers and lakes there are. A river runs to the sea or off the map; a lake doesn't.</li>
        </ul>
        ${tip('High ground adds land value, and so does a view of water. A gentle hillside above a lake is prime residential land.')}`,
    },
    {
      id: 'disasters',
      title: 'Disasters',
      html: `
        <p>Random disasters start once a city passes ${num(DISASTER_POP)} residents, on every difficulty. The advisor asks for a first fire station at ${num(STATION_POP)}, so there is time to build one before they do. They can be switched off from the Disasters menu, and harder difficulties bring them more often.</p>
        ${table(['Disaster', 'How to prepare'], [
          ['Fire', 'The most common by far. Fire stations prevent fires and put them out. Buildings far from a station catch fire more often, and fire spreads through trees and touching buildings. Bulldoze a gap to stop it: a gap cleared beside a fire is a firebreak, and undo can’t put it back.'],
          ['Flood', 'Starts on low shoreline and spreads over land a few metres above the water. Keep valuable buildings on higher ground: the Elevation layer shows it, in 5 m bands near the water. High Water’s tides come in from the whole shore at once.'],
          ['Tornado', 'Wanders near the town centre. You cannot stop it, so keep money in reserve to rebuild.'],
          ['Earthquake', 'Wrecks buildings and roads within about 16 tiles and starts fires. Good fire cover limits the damage.'],
          ['Monster', 'Comes out of the water only when the air is dirty, at a pollution index of 24 or more (9 in Monster Bay), heads for the most polluted spot, and leaves fires in what it wrecks. Clean air keeps it away.'],
          ['Meltdown', 'Only with a nuclear plant: a small chance each month, or if the plant is destroyed. It leaves the ground within about 7 tiles radioactive in patches for 12 to 21 years (12 tiles in Fallout), where nothing can be built.'],
        ])}
        ${tip('Every message in the news ticker with a location has a Go there button.')}`,
    },
    {
      id: 'challenges',
      title: 'Challenges',
      html: `
        ${table(['Challenge', 'How to approach it'], [
          ['Boomtown', 'Money is tight. Build one coal plant and lay roads every 7 tiles to save asphalt. Then zone well ahead of the RCI meter, a dozen or more lots of housing and a few of shops and industry early on: each lot fills in slowly, so the number of lots sets the pace, and money for roads is the limit, not demand. Twelve thousand residents needs roughly six thousand jobs.'],
          ['Gridlock', 'The city opens with about 17,500 people and 8,000 jobs, its factories already past the 4,000 jobs industry reaches without a seaport. Build a seaport so they can grow toward the 10,000 jobs the council wants, and an airport before shops reach 5,000. Every new job and resident brings more cars, though, so run rail from the outer housing into downtown, add parallel roads beside the busy ones, and zone pockets of commerce inside the residential rings. Schools, hospitals and parks raise land value, which lets the city grow denser, and busier.'],
          ['Smog Valley', 'The four coal plants stand among the homes, and while they run the air where people live sits right at the goal\'s line of 12. Replace them with nuclear, solar or wind away from the houses, and zone homes where they stood. Parks in place of the homes round a coal plant clear the air too, but cost the residents the goal needs. Housing stops at 18,000 residents until you build a stadium. The goal has to hold at every month end of the last year, so get there with time to spare.'],
          ['Aftershock', 'Put the fires out first: check fire cover and bulldoze firebreaks. Then clear rubble and reconnect roads and power, but rebuilding alone tops out under 40,000: to reach 45,000, open new blocks as the RCI meter allows, push land value up with hospitals and schools, and build a seaport so industry can grow.'],
          ['Monster Bay', 'The monster surfaces every two years and comes ashore only while the pollution index is 9 or more, then heads for the smokiest spot. The city opens at about 6 and gets smokier as it grows, mostly from the factories among its homes and its traffic. Replace the coal plants with a nuclear plant, megawatt for megawatt the cheapest clean power. It rarely melts down on its own, but it will if the monster comes ashore and smashes it. Keep fire cover up for the fires the monster starts, and taxes near 7% to hold approval above 60%. Housing stops at 18,000 residents without a stadium, which is all the goal asks.'],
          ['High Water', 'Each high tide covers the land below its line wherever the sea can get to it over land that low, and each comes a quarter of a metre higher than the last: 2 m in April 2047, 6.75 m by October 2056. Three months ahead, the news says how high the next one comes and how many buildings stand in its way. Build a bank along the shore, higher than the tides will come: Level land raises open ground to the height where you first press, so start on high ground and drag along the shore, from high ground at one end to high ground at the other. Level land leaves the ground under roads and buildings as it is, and the water finds any gap, so bulldoze whatever stands where the bank goes: on the city’s sea front, the road and the factory beside the little bridge. Inspect shows how high a tile is. Then grow behind the bank: the city opens short of shops, and housing stops at 18,000 residents until you build a stadium.'],
          ['Crime Wave', 'Crime grows where people are crowded and land is cheap, and the city opens with no police station at all, at a crime index of about 20. A police station cuts crime within about 18 tiles: three or four spread through the city bring it near 0, and new blocks at the edge need their own as the city grows. Police alone leave the city well short of 22,000 residents, though. Schools, a hospital and parks raise land value, which lets homes grow denser and cuts crime as well. Housing stops at 18,000 residents until you build a stadium, and shops at 5,000 jobs until you build an airport.'],
          ['Fallout', 'The reactor melts down as the challenge opens, and the city’s only power goes with it: every zone is dark until a new plant is connected, and dark zones empty out month by month, so build one at once. A nuclear plant is the cheapest way back, $5,000 for 2,000 MW, and keeps the air clean, though it too can melt down, rarely; two coal plants cost $6,000 for 1,400 MW. The ground within about 12 tiles of the old reactor is radioactive in patches for 12 to 21 years: nothing can be built on it, and homes and shops whose middle stands on it empty out. Put out the fires, then grow on clean ground. Power alone leaves the city short of 34,000 residents.'],
        ])}`,
    },
    {
      id: 'classes',
      title: 'City sizes and score',
      html: `${table(['Class', 'Residents'], CITY_CLASSES.map((c) => [c.name, c.min ? `${num(c.min)}+` : 'under 2,000']), [1])}
        <p>The city report scores the city out of 1,000. The mayor’s approval weighs most, 7 points for each percent, up to 700. Each size class past ${CITY_CLASSES[0].name} adds 50, up to ${(CITY_CLASSES.length - 1) * 50} for a ${CITY_CLASSES[CITY_CLASSES.length - 1].name.toLowerCase()}, and land value adds up to 50. The History charts show the approval behind it. A sandbox city, where nothing costs money, has no score.</p>
        <p>Reaching Town brings a gift: a Mayor’s house, free, placed from the civic tools where it is marked Gift. It raises land value for about ${GIFT_REACH} tiles around it, up to ${money(GIFT_LV * 40)}/acre at its door. A city has one at a time: if it is lost, the tool comes back.</p>
        <p>At the end of each year the city’s paper comes out: the year’s biggest news as its headline (a year in debt, a disaster, a new size class, a landmark, record growth, brownouts), residents and the change on the year before, the top worry, approval, and the year’s surplus or deficit. On Ultra it waits until you pause, and Settings turns it off.</p>`,
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
      const pop = num(ZONE_POP[kind][level]);
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
    root.querySelector(`#guide-${bt.dataset.go}`)?.scrollIntoView({ behavior: lessMotion() ? 'auto' : 'smooth', block: 'start' });
  });
  return root;
}

/** Highlight the section in view; call once the guide is inside its scrolling container. */
export function trackGuide(root: HTMLElement, scroller: HTMLElement): void {
  const nav = root.querySelector<HTMLElement>('.guide-nav')!;
  const buttons = [...root.querySelectorAll<HTMLElement>('[data-go]')];
  const secs = [...root.querySelectorAll<HTMLElement>('.guide-body section')];
  let last = '';
  const update = () => {
    // On a phone the tabs are a strip over the top of the article: a section is current once its heading clears it.
    const strip = getComputedStyle(nav).flexDirection === 'row';
    const top = strip ? nav.getBoundingClientRect().bottom + 16 : scroller.getBoundingClientRect().top + 60;
    let current = secs[0]?.id;
    for (const s of secs) if (s.getBoundingClientRect().top <= top) current = s.id;
    // The last sections are too short to reach the top: at the very end, the last one is current.
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) current = secs[secs.length - 1]?.id;
    for (const bt of buttons) bt.setAttribute('aria-current', String(`guide-${bt.dataset.go}` === current));
    if (current === last) return;
    last = current;
    // Keep the current tab in sight in the strip.
    const on = buttons.find((bt) => `guide-${bt.dataset.go}` === current);
    if (strip && on) {
      if (on.offsetLeft < nav.scrollLeft) nav.scrollLeft = on.offsetLeft - 12;
      else if (on.offsetLeft + on.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = on.offsetLeft + on.offsetWidth - nav.clientWidth + 12;
    }
  };
  scroller.addEventListener('scroll', update, { passive: true });
  update();
}

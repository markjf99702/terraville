// Game rules as data: building kinds, costs, tool list, zone densities.

export const ROAD = 1;
export const RAIL = 2;
export const POWER = 4;

export type Kind =
  | 'res' | 'com' | 'ind'
  | 'police' | 'fire' | 'school' | 'hospital'
  | 'park' | 'stadium' | 'seaport' | 'airport'
  | 'coal' | 'nuclear' | 'wind' | 'solar';

export interface BuildingDef {
  kind: Kind;
  name: string;
  size: number;
  cost: number;
  /** Monthly running cost at full funding. */
  upkeep: number;
  /** Generating capacity in MW; each building tile on the grid draws 1 MW. */
  capacity?: number;
  /** Pollution emitted at the building (0-255 scale before blurring). */
  pollution?: number;
  needsShore?: boolean;
  /** How far a steep site can be: max height spread across the footprint in metres. */
  maxSpread: number;
  blurb: string;
}

export const BUILDINGS: Record<Kind, BuildingDef> = {
  res: { kind: 'res', name: 'Residential zone', size: 3, cost: 100, upkeep: 0, maxSpread: 9, blurb: 'Homes. Grows from cottages to towers when land value is high.' },
  com: { kind: 'com', name: 'Commercial zone', size: 3, cost: 100, upkeep: 0, maxSpread: 9, blurb: 'Shops and offices. Needs customers from residential zones.' },
  ind: { kind: 'ind', name: 'Industrial zone', size: 3, cost: 100, upkeep: 0, maxSpread: 9, blurb: 'Factories and warehouses. Jobs, and pollution.' },
  police: { kind: 'police', name: 'Police station', size: 3, cost: 500, upkeep: 45, maxSpread: 9, blurb: 'Cuts crime within about 18 tiles.' },
  fire: { kind: 'fire', name: 'Fire station', size: 3, cost: 500, upkeep: 45, maxSpread: 9, blurb: 'Puts out fires and prevents new ones nearby.' },
  school: { kind: 'school', name: 'School', size: 3, cost: 800, upkeep: 40, maxSpread: 9, blurb: 'Raises land value and draws families to nearby homes.' },
  hospital: { kind: 'hospital', name: 'Hospital', size: 3, cost: 1200, upkeep: 60, maxSpread: 9, blurb: 'Raises land value and lets neighbourhoods grow denser.' },
  park: { kind: 'park', name: 'Park', size: 1, cost: 10, upkeep: 0.3, maxSpread: 30, blurb: 'Raises land value and soaks up a little pollution.' },
  stadium: { kind: 'stadium', name: 'Stadium', size: 4, cost: 3000, upkeep: 30, maxSpread: 8, blurb: 'Big residential cities demand one.' },
  seaport: { kind: 'seaport', name: 'Seaport', size: 4, cost: 5000, upkeep: 50, pollution: 60, needsShore: true, maxSpread: 8, blurb: 'Lets industry export. Must touch water.' },
  airport: { kind: 'airport', name: 'Airport', size: 6, cost: 10000, upkeep: 80, pollution: 90, maxSpread: 6, blurb: 'Big commercial cities need one.' },
  coal: { kind: 'coal', name: 'Coal plant', size: 4, cost: 3000, upkeep: 25, capacity: 700, pollution: 255, maxSpread: 8, blurb: '700 MW. Cheap and dirty.' },
  nuclear: { kind: 'nuclear', name: 'Nuclear plant', size: 4, cost: 5000, upkeep: 60, capacity: 2000, maxSpread: 8, blurb: '2,000 MW and clean air. Rarely, a meltdown.' },
  wind: { kind: 'wind', name: 'Wind turbine', size: 1, cost: 250, upkeep: 2, capacity: 18, maxSpread: 40, blurb: '18 MW. Hilltops are fine.' },
  solar: { kind: 'solar', name: 'Solar farm', size: 3, cost: 2600, upkeep: 12, capacity: 160, maxSpread: 9, blurb: '160 MW of quiet power.' },
};

export const ZONES: Kind[] = ['res', 'com', 'ind'];
export function isZone(k: Kind): boolean {
  return k === 'res' || k === 'com' || k === 'ind';
}

/** Residents (res) or jobs (com, ind) at each density level. Level 0 is a vacant lot. */
export const ZONE_POP: Record<'res' | 'com' | 'ind', number[]> = {
  res: [0, 24, 48, 72, 96, 360, 800, 1400, 2200],
  com: [0, 60, 180, 420, 800, 1500],
  ind: [0, 90, 240, 460, 760],
};
export const RES_HOUSE_LEVELS = 4;

/** Minimum land value (0-255) needed to reach each density level. */
export const ZONE_LV_GATE: Record<'res' | 'com' | 'ind', number[]> = {
  res: [0, 0, 0, 0, 0, 55, 95, 135, 175],
  com: [0, 0, 40, 80, 120, 165],
  ind: [0, 0, 0, 0, 0],
};

export const NET_COST = { road: 10, rail: 20, power: 5 };
export const BRIDGE_COST = { road: 60, rail: 120, power: 25 };
/** Monthly upkeep per tile. */
export const NET_UPKEEP = { road: 0.15, rail: 0.3, bridge: 1 };
/** Max height difference to a neighbour, in metres, that each network tolerates. */
export const NET_MAX_SLOPE = { road: 14, rail: 9, power: 999 };
export const BULLDOZE_COST = 1;
/** Dollars per metre of earth moved, by the Level land brush or when a lot is graded. */
export const GRADE_COST = 2;
/** Lots up to this many times their normal slope limit are graded automatically. */
export const AUTO_GRADE = 3;

export type ToolKind = 'click' | 'line' | 'zone' | 'rect' | 'place' | 'brush';

export interface ToolDef {
  id: string;
  name: string;
  kind: ToolKind;
  key?: string;
  building?: Kind;
  net?: number;
  cost?: number;
  group: string;
  tip: string;
}

export const CITY_TOOLS: ToolDef[] = [
  { id: 'query', name: 'Inspect', kind: 'click', key: 'q', group: 'look', tip: 'Click a tile to see what is there.' },
  { id: 'bulldoze', name: 'Bulldoze', kind: 'rect', key: 'b', cost: BULLDOZE_COST, group: 'look', tip: 'Drag to clear buildings, roads, trees and rubble. $1 a tile. It does not flatten hills: use Level land for that.' },
  { id: 'road', name: 'Road', kind: 'line', key: 'r', net: ROAD, cost: NET_COST.road, group: 'move', tip: 'Drag to lay road. Over water it becomes a bridge.' },
  { id: 'rail', name: 'Rail', kind: 'line', key: 't', net: RAIL, cost: NET_COST.rail, group: 'move', tip: 'Drag to lay track. Trips by rail add no car traffic.' },
  { id: 'power', name: 'Power line', kind: 'line', key: 'p', net: POWER, cost: NET_COST.power, group: 'move', tip: 'Carries power. Zones also pass power to neighbours.' },
  { id: 'res', name: 'Residential', kind: 'zone', key: '1', building: 'res', group: 'zone', tip: '' },
  { id: 'com', name: 'Commercial', kind: 'zone', key: '2', building: 'com', group: 'zone', tip: '' },
  { id: 'ind', name: 'Industrial', kind: 'zone', key: '3', building: 'ind', group: 'zone', tip: '' },
  { id: 'park', name: 'Park', kind: 'rect', key: 'k', building: 'park', group: 'civic', tip: '' },
  { id: 'police', name: 'Police', kind: 'place', building: 'police', group: 'civic', tip: '' },
  { id: 'fire', name: 'Fire station', kind: 'place', building: 'fire', group: 'civic', tip: '' },
  { id: 'school', name: 'School', kind: 'place', building: 'school', group: 'civic', tip: '' },
  { id: 'hospital', name: 'Hospital', kind: 'place', building: 'hospital', group: 'civic', tip: '' },
  { id: 'stadium', name: 'Stadium', kind: 'place', building: 'stadium', group: 'civic', tip: '' },
  { id: 'coal', name: 'Coal plant', kind: 'place', building: 'coal', group: 'power', tip: '' },
  { id: 'nuclear', name: 'Nuclear', kind: 'place', building: 'nuclear', group: 'power', tip: '' },
  { id: 'wind', name: 'Wind turbine', kind: 'place', building: 'wind', group: 'power', tip: '' },
  { id: 'solar', name: 'Solar farm', kind: 'place', building: 'solar', group: 'power', tip: '' },
  { id: 'seaport', name: 'Seaport', kind: 'place', building: 'seaport', group: 'port', tip: '' },
  { id: 'airport', name: 'Airport', kind: 'place', building: 'airport', group: 'port', tip: '' },
  { id: 'trees', name: 'Plant trees', kind: 'rect', key: 'g', cost: 3, group: 'land', tip: 'Drag to plant trees. $3 a tile.' },
  { id: 'level', name: 'Level land', kind: 'brush', key: 'l', group: 'land', tip: 'Hold over a slope to flatten it to the height where you first pressed. $2 per metre of earth moved. Zones and buildings also level gentle slopes by themselves.' },
];

for (const t of CITY_TOOLS) {
  if (t.building) {
    const d = BUILDINGS[t.building];
    t.cost = d.cost;
    if (!t.tip) t.tip = d.blurb;
  }
}

export const EDITOR_TOOLS: ToolDef[] = [
  { id: 'pan', name: 'Look around', kind: 'click', key: 'q', group: 'look', tip: 'Drag to move the map. Click to read elevation.' },
  { id: 'raise', name: 'Raise', kind: 'brush', key: 'r', group: 'shape', tip: 'Push the ground up. Hold to keep raising.' },
  { id: 'lower', name: 'Lower', kind: 'brush', key: 'f', group: 'shape', tip: 'Dig down. Below sea level it floods.' },
  { id: 'smooth', name: 'Smooth', kind: 'brush', key: 's', group: 'shape', tip: 'Soften cliffs and bumps.' },
  { id: 'flatten', name: 'Flatten', kind: 'brush', key: 'l', group: 'shape', tip: 'Level to the height where the stroke started.' },
  { id: 'roughen', name: 'Roughen', kind: 'brush', key: 'n', group: 'shape', tip: 'Add crags and noise.' },
  { id: 'water', name: 'Water', kind: 'brush', key: 'w', group: 'paint', tip: 'Paint lakes and channels at any height.' },
  { id: 'land', name: 'Dry land', kind: 'brush', key: 'd', group: 'paint', tip: 'Paint water away.' },
  { id: 'spring', name: 'Spring', kind: 'click', key: 'v', group: 'paint', tip: 'Click high ground: a river finds its own way downhill.' },
  { id: 'forest', name: 'Forest', kind: 'brush', key: 'g', group: 'paint', tip: 'Paint trees.' },
  { id: 'clear', name: 'Clear trees', kind: 'brush', key: 'c', group: 'paint', tip: 'Remove trees.' },
];

export interface Difficulty {
  id: 'easy' | 'medium' | 'hard';
  name: string;
  funds: number;
  income: number;
  disasters: number;
}
export const DIFFICULTIES: Difficulty[] = [
  { id: 'easy', name: 'Easy', funds: 20000, income: 1.2, disasters: 0.5 },
  { id: 'medium', name: 'Medium', funds: 10000, income: 1.0, disasters: 1 },
  { id: 'hard', name: 'Hard', funds: 5000, income: 0.85, disasters: 1.6 },
];

export const MAP_SIZES = [
  { id: 'small', name: 'Small', w: 72, h: 60 },
  { id: 'classic', name: 'Classic', w: 120, h: 100 },
  { id: 'large', name: 'Large', w: 180, h: 150 },
];

export const CITY_CLASSES: { min: number; name: string }[] = [
  { min: 0, name: 'Village' },
  { min: 2000, name: 'Town' },
  { min: 10000, name: 'City' },
  { min: 50000, name: 'Capital' },
  { min: 100000, name: 'Metropolis' },
  { min: 500000, name: 'Megalopolis' },
];

export function cityClass(pop: number): string {
  let name = CITY_CLASSES[0].name;
  for (const c of CITY_CLASSES) if (pop >= c.min) name = c.name;
  return name;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const START_YEAR = 1900;

export function dateLabel(month: number): string {
  return `${MONTHS[month % 12]} ${START_YEAR + Math.floor(month / 12)}`;
}

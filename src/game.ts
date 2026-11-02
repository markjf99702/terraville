// Game controller: modes, the tool state machine, money, undo, the clock.
import { Audio } from './audio';
import {
  BUILDINGS, CITY_CLASSES, CITY_TOOLS, DIFFICULTIES, Difficulty, EDITOR_TOOLS, GRADE_COST, Kind, MAP_SIZES, SEP, ToolDef, Upgrade,
  article, buildingName, cityClass, isZone, nextUpgrade,
} from './defs';
import { Minimap } from './render/minimap';
import { Renderer, SLOPE_CLASSES } from './render/renderer';
import { hashString, makeRng, pick, randomSeedName } from './rng';
import { CityMeta, Drive, DriveCopy } from './drive';
import {
  SaveFile, SlotMeta, citySlot, decode, deleteSlot, encode, encodeNow, listSlots, newCityId, pushSaved, readCode, saveCode, saveSlot, slotKey,
  thisDevice, worldFrom,
} from './save';
import { SCENARIOS, buildScenario, goalState, openScenario, scenarioMonth } from './scenarios';
import { Sim } from './sim';
import { DEFAULT_TERRAIN, TerrainParams, TerrainStyle, addSpring, applyBrush, cleanTerrain, generateTerrain } from './terrain';
import {
  Plan, applyBuildings, applyBulldoze, applyLine, applyTrees, linePath, planBulldoze, planLine, planParks, planPlace,
  planTrees, planZones, rectTiles, levelCost,
} from './tools';
import type { UI } from './ui/ui';
import { AreaSnapshot, Box, Building, World, WorldSnapshot, newCityState } from './world';

export type Mode = 'title' | 'editor' | 'city';

interface UndoEntry {
  /** The whole map in the editor. In a city, just the area the action touched. */
  snap: WorldSnapshot | AreaSnapshot;
  cost: number;
  /** The month of the action, to decide whether undoing it still refunds the cost. */
  month: number;
  /** Still a whole-map copy, waiting to be cut down to the area that changed. */
  open?: boolean;
  /** For a brush stroke: the area it has touched so far (null for none yet). */
  within?: Box | null;
  /** A landmark upgrade, which changes land value across the city. */
  upgrade?: boolean;
  /** In a city, the area as the action left it: undo (or redo) is refused once it has been wrecked since. */
  after?: AreaSnapshot;
}

/** Undo refunds an action's cost for this many game months after it (always while paused). */
const REFUND_MONTHS = 3;

/** Simulated weeks per real second at each speed. */
export const SPEEDS = [0, 0.7, 1.8, 5, 14];
/** The most simulation one frame takes on before it lets the frame be drawn, in ms. */
const SIM_MS_PER_FRAME = 10;
export const SPEED_NAMES = ['Paused', 'Slow', 'Normal', 'Fast', 'Ultra'];

export interface Settings {
  sound: boolean;
  autosave: boolean;
  traffic: boolean;
  grid: boolean;
  contours: boolean;
  night: boolean;
}

const NAME_A = ['Maple', 'Cedar', 'River', 'Lake', 'Stone', 'Pine', 'Oak', 'Harbor', 'Fair', 'Bright', 'Silver', 'Green', 'Elm', 'Clear', 'Red', 'Willow', 'Ash', 'Hazel', 'North', 'Bay', 'Copper', 'Sand', 'Glen', 'Mill'];
const NAME_B = ['ton', 'ville', 'field', 'wood', 'port', 'ford', 'brook', 'haven', 'dale', 'ridge', 'view', 'burg', 'crest', 'bury', 'water', 'mont', 'stead'];

export function randomCityName(): string {
  const r = makeRng((Date.now() ^ (Math.random() * 1e9)) >>> 0);
  return pick(r, NAME_A) + pick(r, NAME_B);
}

/**
 * What tabs of the game in one browser tell each other, so that two never play (and save) the same city: a new tab
 * asks who is playing what, each answers with its city ('' for none), a tab that opens a city claims it, and a tab
 * about to open a city another is playing asks that one to save and hand it over first.
 */
type TabNote =
  | { t: 'hello'; tab: string }
  | { t: 'playing' | 'claim' | 'handover'; tab: string; city: string }
  | { t: 'handed'; tab: string; city: string; code: string | null }
  | { t: 'bye'; tab: string };

/** How long opening a city waits for the tab playing it to save and stop, should that tab not answer. */
const HANDOVER_WAIT = 2000; // ms

/** The radius of Level land's circle in a new city or a challenge, in tiles. */
const CITY_BRUSH = 4;

/** The terrain editor's opening toast. On a phone the brushes are along the bottom, and a touch screen has no wheel. */
const EDITOR_HINT = () =>
  `Drag to move the map, ${matchMedia('(hover: none) and (pointer: coarse)').matches ? 'pinch' : 'scroll or pinch'} to zoom. Pick a brush ${window.innerWidth <= 820 ? 'below' : 'on the left'} to shape the land.`;

function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString();
}

export class Game {
  mode: Mode = 'title';
  world!: World;
  sim: Sim | null = null;
  renderer: Renderer;
  minimap: Minimap;
  audio = new Audio();
  ui!: UI;
  drive: Drive;
  speed = 2;
  terrain: TerrainParams;
  toolId = 'query';
  brush = { radius: 4, strength: 0.6 };
  settings: Settings = { sound: true, autosave: true, traffic: true, grid: false, contours: false, night: true };
  slotId: string | null = null;

  private acc = 0;
  /** Undo entries: the map before an action and what the action cost. */
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  /** A building placement waiting for the pointer to lift. */
  private pendingPlace = false;
  private anchor: { x: number; y: number } | null = null;
  private brushOn = false;
  private brushAt = { x: 0, y: 0 };
  /** Where the brush is on the screen, for its tip. */
  private brushScreen = { x: 0, y: 0 };
  private brushTarget: number | undefined;
  private brushSpent = 0;
  private autoTimer = 0;
  private titleDrift = { vx: 1.3, vy: 0.5 };
  /** This tab, to other tabs of the game. */
  readonly tab = newCityId();
  private channel: BroadcastChannel | null = null;
  /** The city each other tab said it is playing, by tab. */
  private elsewhere = new Map<string, string>();
  /** Waiting for another tab to hand over a city: called with the city's id, and its code, when it has. */
  private onHanded: ((city: string, code: string | null) => void) | null = null;
  /** The code this tab last opened a city from, so the echo of the save it was handed isn't taken for a rival's. */
  private openedCode: string | null = null;
  /**
   * Set when another tab took over this city: nothing here saves it (not the 90-second save, the year's end, leaving
   * the page or Drive) until it is opened here again.
   */
  stopped = false;

  constructor(canvas: HTMLCanvasElement, minimapCanvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.minimap = new Minimap(minimapCanvas, this.renderer);
    const size = MAP_SIZES[1];
    this.terrain = { ...DEFAULT_TERRAIN, seed: randomSeedName(), w: size.w, h: size.h };
    this.loadSettings();
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* blocked */
    }
    this.drive = new Drive({ fetch: (u, o) => fetch(u, o), storage, now: () => Date.now(), device: thisDevice(), origin: location.origin });
    this.drive.onSignedIn = () => this.pushLocalCities();
    if (this.drive.connected) this.drive.prepare();
    // Saves that missed Drive (the page closed first, or there was no connection) go up as soon as they can: now,
    // while Google's sign-in from earlier still holds, and whenever the connection comes back.
    if (this.drive.hasToken()) this.pushLocalCities();
    window.addEventListener('online', () => {
      this.pushLocalCities();
      void this.drive.flush();
    });
    // Leaving the page (switching apps, closing the tab, reloading) saves. A closing page never finishes the
    // compressed save, so the city is written at once as a plain code first; the compressed save and the Drive
    // upload then replace it if the page lives on, as it does when switching apps.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden' || this.mode !== 'city' || !this.settings.autosave || this.stopped) return;
      this.saveCityNow();
      void this.saveCity();
    });
    // Two tabs on one city would save over each other, so the one that opened it last plays it. A browser without
    // BroadcastChannel still hears another tab save the city, through a 'storage' event.
    try {
      this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('terraville');
    } catch {
      this.channel = null;
    }
    if (this.channel) this.channel.onmessage = (e: MessageEvent) => this.onTabNote(e.data as TabNote);
    this.post({ t: 'hello', tab: this.tab });
    window.addEventListener('pagehide', () => this.post({ t: 'bye', tab: this.tab }));
    window.addEventListener('storage', (e) => {
      const id = this.world?.city.id;
      if (!id || !this.playing(id) || e.newValue === null || e.key !== slotKey(citySlot(id)) || e.newValue === this.openedCode) return;
      this.yieldCity();
    });
  }

  // ---- other tabs --------------------------------------------------------------

  private post(note: TabNote): void {
    try {
      this.channel?.postMessage(note);
    } catch {
      /* closed */
    }
  }

  /** Playing this city here, and not stopped for another tab. */
  private playing(city: string): boolean {
    return this.mode === 'city' && !this.stopped && !!city && this.world.city.id === city;
  }

  private onTabNote(n: TabNote): void {
    if (!n || typeof n !== 'object' || typeof n.tab !== 'string' || n.tab === this.tab) return;
    const city = 'city' in n && typeof n.city === 'string' ? n.city : '';
    switch (n.t) {
      case 'hello':
        if (this.mode === 'city' && !this.stopped && this.world.city.id) this.post({ t: 'playing', tab: this.tab, city: this.world.city.id });
        break;
      case 'playing':
      case 'claim':
        if (city) this.elsewhere.set(n.tab, city);
        else this.elsewhere.delete(n.tab);
        if (n.t === 'claim' && this.playing(city)) this.yieldCity();
        break;
      case 'handover': {
        if (!this.playing(city)) break;
        // The city goes to the other tab as it stands, so nothing played here is lost, and is saved here too. It
        // travels with the message: another tab can read localStorage a moment before this tab's save reaches it.
        let code: string | null = null;
        try {
          code = encodeNow(this.makeSaveFile());
          if (this.settings.autosave) this.keepCity(code, this.saveMeta());
        } catch {
          /* the other tab opens the last save instead */
        }
        this.yieldCity();
        this.post({ t: 'handed', tab: this.tab, city, code });
        break;
      }
      case 'handed':
        this.elsewhere.delete(n.tab);
        this.onHanded?.(city, 'code' in n && typeof n.code === 'string' ? n.code : null);
        break;
      case 'bye':
        this.elsewhere.delete(n.tab);
        break;
    }
  }

  /** Tell other tabs this one opened its city: a tab playing the same city stops. */
  private claimCity(): void {
    const id = this.world.city.id;
    if (this.mode === 'city' && id) this.post({ t: 'claim', tab: this.tab, city: id });
  }

  /** Another tab opened this city: stop, save nothing, and say so. */
  private yieldCity(): void {
    this.stopped = true;
    this.setSpeed(0);
    this.post({ t: 'playing', tab: this.tab, city: '' });
    this.ui.cityTakenElsewhere(this.world.city.name);
  }

  /**
   * Before opening a city from its save: if another tab is playing it, have that tab save it and stop. Resolves with
   * the city as that tab handed it over, or null when no tab had it (or it didn't answer).
   */
  private handover(city: string | undefined): Promise<string | null> {
    if (!city || ![...this.elsewhere.values()].includes(city)) return Promise.resolve(null);
    return new Promise((done) => {
      const finish = (code: string | null) => {
        clearTimeout(timer);
        this.onHanded = null;
        done(code);
      };
      const timer = setTimeout(() => finish(null), HANDOVER_WAIT);
      this.onHanded = (c, code) => {
        if (c === city) finish(code);
      };
      this.post({ t: 'handover', tab: this.tab, city });
    });
  }

  /**
   * Open a save from this device, first taking its city over from any other tab playing it. Throws with a readable
   * message when the save can't be read.
   */
  async openSlot(id: string): Promise<void> {
    const meta = listSlots().find((s) => s.id === id);
    const code = (await this.handover(meta?.city)) ?? readCode(id);
    if (!code) throw new Error('That save could not be read.');
    let f: SaveFile;
    try {
      f = await decode(code);
      World.deserialize(f.world);
    } catch (e) {
      throw new Error(`That save is damaged: ${(e as Error).message}`);
    }
    this.loadFile(f, id);
    this.openedCode = code;
  }

  /** "Play it here instead": open this city's save again, which stops the tab that took it over. */
  async playHere(): Promise<boolean> {
    const id = this.world.city.id;
    if (!id) return false;
    try {
      await this.openSlot(citySlot(id));
      return true;
    } catch {
      return false;
    }
  }

  // ---- settings --------------------------------------------------------------

  private loadSettings(): void {
    try {
      const raw = localStorage.getItem('terraville.settings');
      if (raw) this.settings = { ...this.settings, ...JSON.parse(raw) };
    } catch {
      /* private mode */
    }
    this.applySettings();
  }

  saveSettings(): void {
    try {
      localStorage.setItem('terraville.settings', JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.applySettings();
  }

  private applySettings(): void {
    this.audio.enabled = this.settings.sound;
    this.renderer.showTraffic = this.settings.traffic;
    this.renderer.nightCycle = this.settings.night;
    if (this.renderer.grid !== this.settings.grid) {
      this.renderer.grid = this.settings.grid;
      if (this.world) this.renderer.invalidateAll();
    }
    const wantContours = this.mode === 'editor' ? true : this.settings.contours;
    if (this.renderer.contours !== wantContours) this.renderer.contours = wantContours;
  }

  // ---- modes -----------------------------------------------------------------

  showTitle(): void {
    this.mode = 'title';
    this.setSim(null);
    this.clearUndo();
    this.renderer.setOverlay('none');
    const styles: TerrainStyle[] = ['coast', 'island', 'lakes', 'valley', 'archipelago'];
    const seed = randomSeedName();
    const style = styles[hashString(seed) % styles.length];
    const size = MAP_SIZES[1];
    this.terrain = { ...DEFAULT_TERRAIN, style, seed, w: size.w, h: size.h };
    this.world = generateTerrain(this.terrain);
    this.renderer.setWorld(this.world, null);
    this.renderer.resize();
    this.renderer.cam.zoom = Math.max(this.renderer.minZoom() * 1.8, 11);
    this.renderer.centerOn(this.world.w * 0.35, this.world.h * 0.45);
    this.renderer.preview = null;
    this.minimap.markDirty();
    this.applySettings();
    this.ui.enterTitle();
  }

  startEditor(params?: Partial<TerrainParams>): void {
    this.mode = 'editor';
    this.setSim(null);
    this.renderer.setOverlay('none');
    this.terrain = { ...this.terrain, ...params };
    this.world = generateTerrain(this.terrain);
    this.renderer.setWorld(this.world, null);
    this.fitMap();
    this.clearUndo();
    this.slotId = null;
    this.applySettings();
    this.setTool('pan');
    this.minimap.markDirty();
    this.ui.enterEditor();
    this.ui.toast(EDITOR_HINT());
  }

  /** Continue editing the land already on screen (from the title or a quick start). */
  editCurrentLand(): void {
    this.mode = 'editor';
    this.setSim(null);
    this.renderer.setOverlay('none');
    this.world.city = newCityState();
    // Same map as on screen: keep the renderer's cache instead of rebuilding it.
    if (this.renderer.world !== this.world) this.renderer.setWorld(this.world, null);
    else this.renderer.sim = null;
    this.fitMap();
    this.clearUndo();
    this.applySettings();
    this.setTool('pan');
    this.minimap.markDirty();
    this.ui.enterEditor();
    this.ui.toast(EDITOR_HINT());
  }

  regenerate(params: Partial<TerrainParams>): void {
    const next = { ...this.terrain, ...params };
    const sizeChanged = next.w !== this.terrain.w || next.h !== this.terrain.h;
    this.terrain = next;
    const fresh = generateTerrain(next);
    if (!sizeChanged && this.world && this.world.w === fresh.w && this.world.h === fresh.h) {
      this.pushUndo();
      this.world.height.set(fresh.height);
      this.world.water.set(fresh.water);
      this.world.trees.set(fresh.trees);
      this.world.city.seed = next.seed;
      this.world.dirtyAll(true);
    } else {
      this.world = fresh;
      this.renderer.setWorld(fresh, null);
      this.fitMap();
      this.undoStack = [];
      this.redoStack = [];
    }
    this.minimap.markDirty();
  }

  /** A new random landscape and straight to the founding dialog. */
  quickStart(): void {
    const styles: TerrainStyle[] = ['coast', 'island', 'lakes', 'valley', 'coast'];
    const seed = randomSeedName();
    const size = MAP_SIZES[1];
    this.terrain = { ...DEFAULT_TERRAIN, style: styles[hashString(seed) % styles.length], seed, w: size.w, h: size.h };
    this.world = generateTerrain(this.terrain);
    this.mode = 'editor';
    this.setSim(null);
    this.clearUndo();
    this.renderer.setOverlay('none');
    this.renderer.setWorld(this.world, null);
    this.fitMap();
    this.applySettings();
    this.minimap.markDirty();
    this.ui.enterEditor();
    this.ui.openFound(true);
  }

  foundCity(name: string, difficulty: Difficulty['id'], disasters: boolean): void {
    const w = this.world;
    const diff = DIFFICULTIES.find((d) => d.id === difficulty) ?? DIFFICULTIES[0];
    w.city = newCityState();
    w.city.name = name.trim() || randomCityName();
    w.city.difficulty = diff.id;
    w.city.funds = diff.funds;
    w.city.disasters = disasters;
    w.city.founded = true;
    w.city.seed = this.terrain.seed;
    this.startSim();
    this.mode = 'city';
    // A new city waits for the player: nothing costs upkeep or happens until they press play (Space resumes Normal).
    this.speed = 0;
    this.lastSpeed = 2;
    this.clearUndo();
    this.slotId = null;
    this.world.city.id = newCityId();
    this.applySettings();
    this.setTool('query');
    // Level land starts at a modest circle, whatever size the terrain editor's brush was left at.
    this.brush.radius = CITY_BRUSH;
    this.ui.enterCity();
    // One line: the checklist (or, once someone has done it, the guide) has the steps.
    const steps = this.ui.checklistShown() ? 'The checklist has the first steps.' : 'The strategy guide in the menu has the first steps.';
    this.sim!.say('welcome', `Welcome to ${w.city.name}. ${steps}`, 'good', undefined, 0);
    this.renderer.cam.zoom = Math.max(this.renderer.cam.zoom, 14);
    this.renderer.clampCamera();
    this.audio.play('fanfare');
    this.claimCity();
  }

  private setSim(sim: Sim | null): void {
    this.sim?.dispose();
    this.sim = sim;
    // Whatever opens next, this tab isn't stopped for another any more; until a city opens, it plays none.
    this.stopped = false;
    this.openedCode = null;
    if (!sim) this.post({ t: 'playing', tab: this.tab, city: '' });
  }

  private startSim(): void {
    const sim = new Sim(this.world);
    this.setSim(sim);
    this.autosaveFailing = false;
    this.renderer.setWorld(this.world, sim);
    this.minimap.markDirty();
    sim.on((e) => {
      switch (e.type) {
        case 'message':
          this.ui.onMessage(e.message);
          if (e.message.kind === 'alert') this.audio.play('alert');
          break;
        case 'class':
          // A big moment: more than a line in the ticker.
          this.audio.play('fanfare');
          this.ui.toast(e.text);
          this.ui.glowSign();
          break;
        case 'destroyed':
          this.renderer.vehicles.addDust(e.x, e.y);
          break;
        case 'month':
          this.minimap.markDirty();
          this.renderer.refreshOverlay();
          this.ui.onMonth();
          this.checkScenario();
          break;
        case 'year':
          if (e.surplus) this.audio.play('coin');
          if (this.settings.autosave) void this.autosave();
          break;
      }
    });
  }

  /** Start one of the challenges. */
  startScenario(id: string): void {
    const s = SCENARIOS.find((x) => x.id === id);
    if (!s) return;
    const size = MAP_SIZES[1];
    this.world = buildScenario(s, size.w, size.h);
    this.terrain = { ...DEFAULT_TERRAIN, ...s.terrain, seed: this.world.city.seed, w: size.w, h: size.h };
    this.startSim();
    const sim = this.sim!;
    openScenario(sim);
    // A ready-made city starts at its own size class, without the fanfare.
    this.world.city.classReached = CITY_CLASSES.reduce((acc, c, i) => (sim.stats.residents >= c.min ? i : acc), 0);
    this.mode = 'city';
    this.speed = 2;
    this.clearUndo();
    this.slotId = null;
    this.world.city.id = newCityId();
    this.applySettings();
    this.setTool('query');
    // Level land starts at a modest circle, whatever size the terrain editor's brush was left at.
    this.brush.radius = CITY_BRUSH;
    this.ui.enterCity();
    // Look at the middle of whatever is built.
    let cx = 0, cy = 0, n = 0;
    for (const b of this.world.buildings.values()) {
      cx += b.x + b.size / 2;
      cy += b.y + b.size / 2;
      n++;
    }
    this.renderer.resize();
    this.renderer.cam.zoom = n ? 13 : Math.max(this.renderer.minZoom(), 9);
    this.renderer.centerOn(n ? cx / n : this.world.w / 2, n ? cy / n : this.world.h / 2);
    // The goal opens the news, ahead of whatever the challenge sets off.
    sim.say('goal', `${s.goal} You have until ${s.year + s.years}.`, 'info', undefined, 0);
    s.start?.(sim);
    // The top bar's monthly balance is real from the first frame, not +$0 until a month has closed.
    sim.estimateBudget();
    this.minimap.markDirty();
    this.showGoal();
    this.ui.scenarioIntro(s);
    this.claimCity();
  }

  private checkScenario(): void {
    const sc = this.world.city.scenario;
    if (!sc || !this.sim) return;
    const s = SCENARIOS.find((x) => x.id === sc.id);
    if (!s) return;
    const month = this.world.city.month;
    const st = scenarioMonth(s, this.sim);
    this.ui.updateGoal(s, st, sc.end - month, sc.done);
    if (sc.done) return;
    if ((s.kind === 'reach' && st.met) || month >= sc.end) {
      sc.done = st.met ? 'won' : 'lost';
      this.audio.play(st.met ? 'fanfare' : 'error');
      this.ui.updateGoal(s, st, sc.end - month, sc.done);
      this.ui.scenarioResult(s, st, sc.done === 'won');
    }
  }

  /** Fill in the goal tracker as a challenge starts or opens from a save, without a month's events or judging. */
  private showGoal(): void {
    const sc = this.world.city.scenario;
    const s = sc && SCENARIOS.find((x) => x.id === sc.id);
    if (!sc || !s || !this.sim) return;
    this.ui.updateGoal(s, goalState(s, this.sim), sc.end - this.world.city.month, sc.done);
  }

  loadFile(file: SaveFile, slotId: string | null = null): void {
    this.world = worldFrom(file);
    // Cities saved before ids existed get one now; their saves follow it from here on.
    if (file.mode === 'city' && !this.world.city.id) this.world.city.id = newCityId();
    this.terrain = { ...cleanTerrain(file.terrain, this.terrain), w: this.world.w, h: this.world.h };
    this.clearUndo();
    this.slotId = slotId;
    if (file.mode === 'city' && this.world.city.founded) {
      this.mode = 'city';
      this.startSim();
      // The report's worries and the goal tracker are otherwise blank until the first month end. Approval stays as
      // saved: moving it toward the mood here would let each reload nudge it.
      this.sim!.evaluate(false);
      this.speed = 2;
      this.setTool('query');
      this.applySettings();
      this.ui.enterCity();
      this.showGoal();
      this.claimCity();
    } else {
      this.mode = 'editor';
      this.setSim(null);
      this.renderer.setOverlay('none');
      this.renderer.setWorld(this.world, null);
      this.applySettings();
      this.setTool('pan');
      this.ui.enterEditor();
    }
    this.renderer.resize();
    if (file.cam) {
      this.renderer.cam.zoom = file.cam.zoom;
      this.renderer.centerOn(file.cam.x, file.cam.y);
    } else this.fitMap();
    this.minimap.markDirty();
  }

  /**
   * Open a copy of a city, from a code or a snapshot. As a separate city it gets an id of its own, so its saves never
   * replace those of the city it was copied from.
   */
  openCopy(file: SaveFile, slotId: string | null, separate: boolean): void {
    if (separate) file.world.city.id = newCityId();
    this.loadFile(file, separate ? null : slotId);
    // Going back replaces the city's later save: do it now, so the list of saves shows what is being played.
    if (!separate && this.settings.autosave) void this.saveCity();
  }

  makeSaveFile(): SaveFile {
    return {
      v: 1,
      world: this.world.serialize(this.mode === 'city' && this.sim ? this.sim.saveRun() : undefined),
      cam: { ...this.renderer.cam },
      mode: this.mode === 'city' ? 'city' : 'editor',
      terrain: this.terrain,
    };
  }

  /** The 90-second and year-end save. When it fails it says so once, and again only after a save has worked. */
  async autosave(): Promise<boolean> {
    const ok = await this.saveCity();
    if (!ok && !this.autosaveFailing) this.ui.toast(this.ui.saveFailedText(), 'warn');
    this.autosaveFailing = !ok;
    return ok;
  }
  private autosaveFailing = false;

  /** Save the city to its own slot here, and to Google Drive when connected. */
  async saveCity(): Promise<boolean> {
    if (this.mode !== 'city') return true;
    if (this.stopped) return false;
    const meta = this.saveMeta();
    let code: string;
    try {
      code = await encode(this.makeSaveFile());
    } catch {
      return false;
    }
    // Another tab may have taken the city over while the code was being made.
    if (this.stopped) return false;
    const ok = this.keepCity(code, meta);
    // Drive gets it even when this browser's storage is full.
    this.drive.push(code, meta);
    return ok;
  }

  /**
   * Save the city to its own slot here straight away, as a plain city code (about half as big again as the
   * compressed one), for when the page is hiding and may be about to close.
   */
  saveCityNow(): boolean {
    if (this.mode !== 'city') return true;
    if (this.stopped) return false;
    try {
      return this.keepCity(encodeNow(this.makeSaveFile()), this.saveMeta());
    } catch {
      return false;
    }
  }

  private saveMeta(): CityMeta {
    const city = this.world.city;
    if (!city.id) city.id = newCityId();
    return { city: city.id, name: city.name, pop: this.sim?.stats.residents ?? 0, date: city.month, saved: Date.now() };
  }

  /** Store a city code in the city's own slot. The old copy is only replaced once the new one fits. */
  private keepCity(code: string, meta: CityMeta): boolean {
    const ok = saveCode(code, { id: citySlot(meta.city), name: meta.name, pop: meta.pop, date: meta.date, savedAt: meta.saved, mode: 'city', city: meta.city });
    if (ok) {
      // The old single autosave slot is superseded by the city's own.
      if (this.slotId === 'auto') deleteSlot('auto');
      this.slotId = citySlot(meta.city);
    }
    return ok;
  }

  /** Upload every city saved here since its last trip to Drive. */
  pushLocalCities(): void {
    pushSaved(this.drive, listSlots(), readCode);
  }

  /** The newest city saved in this browser. */
  latestLocal(): SlotMeta | undefined {
    return listSlots().find((s) => s.mode === 'city' && (s.city || s.id === 'auto'));
  }

  /** Download a copy of a city from Drive, keep it here, and open it. Throws with a readable message. */
  async openFromDrive(copy: DriveCopy): Promise<void> {
    const code = await this.drive.download(copy.fileId);
    const file = await decode(code);
    World.deserialize(file.world);
    file.world.city.id = copy.city;
    // A tab playing it saves it as it stops; the copy from Drive replaces that save here.
    const handed = await this.handover(copy.city);
    saveCode(code, { id: citySlot(copy.city), name: copy.name, pop: copy.pop, date: copy.date, savedAt: copy.saved, mode: 'city', city: copy.city });
    this.loadFile(file, citySlot(copy.city));
    this.openedCode = handed;
  }

  async saveTo(id: string): Promise<boolean> {
    const ok = await saveSlot(id, this.makeSaveFile(), this.sim?.stats.residents ?? 0);
    if (ok) this.slotId = id;
    return ok;
  }

  async continueLatest(): Promise<boolean> {
    const s = this.latestLocal();
    if (!s) return false;
    try {
      await this.openSlot(s.id);
      return true;
    } catch {
      return false;
    }
  }

  fitMap(): void {
    const r = this.renderer;
    r.resize();
    r.cam.zoom = Math.max(r.minZoom(), Math.min(r.cssW / (this.world.w * 0.62), r.cssH / (this.world.h * 0.62)));
    r.centerOn(this.world.w / 2, this.world.h / 2);
  }

  // ---- clock ------------------------------------------------------------------

  setSpeed(s: number): void {
    this.speed = Math.max(0, Math.min(SPEEDS.length - 1, s));
    this.ui.syncSpeed();
  }

  togglePause(): void {
    if (this.speed === 0) this.setSpeed(this.lastSpeed || 2);
    else {
      this.lastSpeed = this.speed;
      this.setSpeed(0);
    }
  }
  private lastSpeed = 2;

  frame(dt: number): void {
    const r = this.renderer;
    // Pin down what the last action changed before the simulation moves on.
    if (this.mode === 'city' && !this.brushOn) this.sealUndo();
    const running = this.mode === 'city' && !!this.sim && this.speed > 0 && !this.ui.modalOpen && !this.stopped;
    if (running && this.sim) {
      this.acc += dt * SPEEDS[this.speed];
      let steps = 0;
      const t0 = performance.now();
      while (this.acc >= 1 && steps < 6) {
        this.sim.step();
        this.acc -= 1;
        steps++;
        // A big city on a slow phone takes tens of ms a week: past this frame's share the weeks still owed are
        // dropped, so the clock runs as fast as the device can while the map and taps keep up.
        if (performance.now() - t0 > SIM_MS_PER_FRAME) {
          this.acc = 0;
          break;
        }
      }
      if (this.acc > 1) this.acc = 0;
      r.stepFrac = this.acc;
    }
    // Keep the grid current between weekly steps, and while paused, so a new
    // plant or line lights up the zones it reaches as soon as it is built.
    if (this.mode === 'city' && this.sim?.powerDirty) {
      this.sim.computePower();
      if (r.overlay === 'power') r.refreshOverlay();
    }
    r.running = running;
    if (this.mode === 'title') {
      const c = r.cam;
      c.x += this.titleDrift.vx * dt;
      c.y += this.titleDrift.vy * dt;
      const halfW = r.cssW / 2 / c.zoom;
      const halfH = r.cssH / 2 / c.zoom;
      if (c.x > this.world.w - halfW || c.x < halfW) this.titleDrift.vx *= -1;
      if (c.y > this.world.h - halfH || c.y < halfH) this.titleDrift.vy *= -1;
      r.clampCamera(0);
    }
    if (this.brushOn) this.brushTick(dt);
    // The moment for saying what was built is up: the tip goes, and the spot stays quiet until the pointer leaves it.
    if (this.built?.shown && performance.now() >= this.built.until) {
      this.built.shown = false;
      this.ui.cursorTip(0, 0, null);
    }
    if (this.mode === 'city' && this.settings.autosave && !this.stopped) {
      this.autoTimer += dt;
      if (this.autoTimer > 90) {
        this.autoTimer = 0;
        void this.autosave();
      }
    }
    r.frame(dt);
    this.minimap.draw(dt);
  }

  // ---- tools --------------------------------------------------------------------

  tools(): ToolDef[] {
    return this.mode === 'editor' ? EDITOR_TOOLS : CITY_TOOLS;
  }

  tool(): ToolDef {
    const id = this.toolOnce ?? this.toolId;
    return this.tools().find((t) => t.id === id) ?? this.tools()[0];
  }

  /** A tool used for a single drag without changing the selection (Shift-drag bulldozes). */
  private toolOnce: string | null = null;

  useToolOnce(id: string): void {
    this.toolOnce = id;
    this.anchor = null;
  }

  /** Right-click: bulldoze the thing under the cursor, whatever tool is selected. */
  quickBulldoze(fx: number, fy: number, sx: number, sy: number): void {
    if (this.mode !== 'city') return;
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    if (!this.world.inBounds(tx, ty)) return;
    const plan = planBulldoze(this.world, [[tx, ty]]);
    if (!plan.count) {
      this.ui.toast(plan.reason === 'On fire' ? 'That is on fire. Bulldoze a gap around it to stop it spreading.' : 'Nothing to bulldoze there.', 'warn');
      return;
    }
    this.toolOnce = 'bulldoze';
    this.commit(plan, tx, ty);
    this.toolOnce = null;
    this.pointerMove(fx, fy, sx, sy);
  }

  /**
   * What was just built: the tip says so for a moment, and the spot it covers shows no preview (which would only say
   * the spot is taken) until the pointer leaves it. `until` is a performance.now() time.
   */
  private built: { html: string; until: number; tiles: Set<number>; shown: boolean } | null = null;

  /** The steepness layer was switched on by picking Level land, so switch it off after. */
  private autoSlope = false;

  setTool(id: string): void {
    if (this.brushOn && this.mode === 'city') this.setUndoCost(this.brushSpent);
    if (id === 'level' && this.renderer.overlay === 'none') {
      this.renderer.setOverlay('slope');
      this.autoSlope = true;
    } else if (id !== 'level' && this.autoSlope) {
      if (this.renderer.overlay === 'slope') this.renderer.setOverlay('none');
      this.autoSlope = false;
    }
    this.ui?.syncOverlay();
    this.toolId = id;
    this.anchor = null;
    this.pendingPlace = false;
    this.brushOn = false;
    this.built = null;
    this.renderer.preview = null;
    this.ui?.syncTool();
  }

  cancelTool(): void {
    this.toolOnce = null;
    this.built = null;
    this.anchor = null;
    this.pendingPlace = false;
    if (this.brushOn && this.mode === 'city') this.setUndoCost(this.brushSpent);
    this.brushOn = false;
    this.renderer.preview = null;
    this.ui.cursorTip(0, 0, null);
  }

  /**
   * Take back a brush stroke that has only just begun, as if it had never started: a second finger landed, so it was
   * the start of a pinch. The ground goes back, the money is refunded and the undo entry goes, with the redo list as
   * it was. Anything else just stops, as cancelTool does.
   */
  abortStroke(): void {
    if (!this.brushOn) return this.cancelTool();
    this.brushOn = false;
    const top = this.undoStack.pop();
    if (top) {
      if (this.mode === 'city') {
        // The rest of the city kept growing meanwhile: put back only the ground the stroke touched.
        const full = top.snap as WorldSnapshot;
        if (top.open && top.within) this.world.adoptBuilt(full, top.within);
        const area = top.open && top.within ? this.world.changedArea(full, top.within) : null;
        if (area) this.world.restoreArea(this.world.areaSnapshot(area, full));
        this.world.city.funds += this.brushSpent;
        this.ui.onFunds();
      } else this.world.restore(top.snap as WorldSnapshot);
      this.redoStack = this.strokeRedo;
    }
    this.brushSpent = 0;
    this.strokeRedo = [];
    if (this.sim) this.sim.powerDirty = true;
    this.minimap.markDirty();
    this.ui.syncUndo();
    this.cancelTool();
  }
  /** The redo list from before the brush stroke under way, which starting it cleared. */
  private strokeRedo: UndoEntry[] = [];

  /**
   * Start a touch brush stroke that waited `held` seconds to be sure it wasn't a pinch, and make up the time: a hold
   * does as much as before, and a quick tap still does a little.
   */
  strokeDown(fx: number, fy: number, sx: number, sy: number, held: number): void {
    this.pointerDown(fx, fy, sx, sy);
    if (this.brushOn && held > 0) this.brushTick(Math.min(held, 0.25));
  }

  get dragging(): boolean {
    return this.anchor !== null || this.brushOn || this.pendingPlace;
  }

  /** Pointer moved over the map (tile coords, float) at screen position sx, sy. */
  pointerMove(fx: number, fy: number, sx: number, sy: number): void {
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    const r = this.renderer;
    const inside = this.world.inBounds(tx, ty);
    r.hover = inside ? { x: tx, y: ty } : null;
    if (this.mode === 'title') return;
    const t = this.tool();
    if (t.kind === 'brush') {
      this.brushAt = { x: fx, y: fy };
      this.brushScreen = { x: sx, y: sy };
      r.preview = { tiles: [], bad: [], rects: [], brush: { x: fx, y: fy, r: this.brush.radius } };
      if (this.mode === 'editor' && inside) {
        this.ui.cursorTip(sx, sy, `<span class="num">${Math.round(this.world.height[ty * this.world.w + tx])} m</span>`);
      } else if (t.id === 'level' && inside) {
        const spent = this.brushOn ? `Levelling <span class="num">${fmtMoney(this.brushSpent)}</span>${SEP}` : '';
        if (this.world.water[ty * this.world.w + tx]) {
          this.ui.cursorTip(sx, sy, `${spent}<b>Water</b>: Level land can't fill it in`, false);
        } else {
          const s = this.world.slope(tx, ty);
          const cls = SLOPE_CLASSES.find((c) => s <= c.max)!;
          // Before pressing, about what this circle costs to bring to the height under the pointer.
          let ask = spent;
          if (!ask) {
            const est = levelCost(this.world, fx, fy, this.brush.radius, this.world.height[ty * this.world.w + tx]);
            ask = `Hold to level${SEP}${est >= 1 ? `about <span class="num">${fmtMoney(est)}</span> to flatten this circle` : 'nothing here to level'}${SEP}`;
          }
          this.ui.cursorTip(sx, sy, `${ask}<b>${cls.label}</b> (<span class="num">${s.toFixed(1)} m</span>): ${cls.note}`, false);
        }
      }
      return;
    }
    if (this.built && !this.anchor && !this.pendingPlace) {
      if (inside && this.built.tiles.has(ty * this.world.w + tx)) {
        r.preview = null;
        this.ui.cursorTip(sx, sy, this.built.shown ? this.built.html : null);
        return;
      }
      this.built = null;
    }
    if (!inside && !this.anchor) {
      r.preview = null;
      this.ui.cursorTip(0, 0, null);
      return;
    }
    if (t.kind === 'click') {
      r.preview = null;
      if (this.mode === 'editor' && inside) this.ui.cursorTip(sx, sy, `<span class="num">${Math.round(this.world.height[ty * this.world.w + tx])} m</span>`);
      else this.ui.cursorTip(0, 0, null);
      return;
    }
    const plan = this.plan(tx, ty);
    if (!plan) return;
    this.showPlan(plan, sx, sy);
  }

  private plan(tx: number, ty: number): Plan | null {
    const t = this.tool();
    const a = this.anchor ?? { x: tx, y: ty };
    const cx = Math.max(0, Math.min(this.world.w - 1, tx));
    const cy = Math.max(0, Math.min(this.world.h - 1, ty));
    switch (t.kind) {
      case 'line':
        return planLine(this.world, t.net!, linePath(a.x, a.y, cx, cy));
      case 'zone':
        return planZones(this.world, t.building!, a.x, a.y, cx, cy);
      case 'place':
        return planPlace(this.world, t.building!, cx, cy);
      case 'rect': {
        const rect = rectTiles(a.x, a.y, cx, cy);
        if (t.id === 'bulldoze') return planBulldoze(this.world, rect);
        if (t.id === 'park') return planParks(this.world, rect);
        if (t.id === 'trees') return planTrees(this.world, rect, t.cost ?? 3);
      }
    }
    return null;
  }

  private showPlan(plan: Plan, sx: number, sy: number): void {
    const t = this.tool();
    const r = this.renderer;
    const size = t.building ? BUILDINGS[t.building].size : 1;
    const multi = t.kind === 'zone' || t.kind === 'place' || (t.kind === 'rect' && t.building);
    if (multi) {
      r.preview = {
        tiles: [],
        bad: [],
        rects: [...plan.tiles.map(([x, y]) => ({ x, y, s: size, ok: true })), ...plan.bad.map(([x, y]) => ({ x, y, s: size, ok: false }))],
        tint: t.building === 'res' ? '47,207,143' : t.building === 'com' ? '90,166,255' : t.building === 'ind' ? '242,178,27' : undefined,
      };
    } else {
      r.preview = { tiles: plan.tiles, bad: plan.bad, rects: [], tint: t.id === 'bulldoze' ? '242,193,78' : undefined };
    }
    let html: string;
    let bad = false;
    if (!plan.count) {
      html = plan.reason ?? 'Nothing to build here';
      bad = true;
    } else {
      const what = t.kind === 'line' ? `${plan.count} tile${plan.count > 1 ? 's' : ''}` :
        t.kind === 'zone' ? `${plan.count} zone${plan.count > 1 ? 's' : ''}` :
        t.id === 'bulldoze' ? `${plan.count} to clear` :
        t.kind === 'rect' ? `${plan.count} tile${plan.count > 1 ? 's' : ''}` : t.name;
      html = `${t.kind === 'place' ? '' : t.name + SEP}${what}${SEP}<span class="num">${fmtMoney(plan.cost)}</span>`;
      if (plan.grading) html += `${SEP}includes <span class="num">${fmtMoney(plan.grading)}</span> ${t.kind === 'line' ? 'to grade the slope' : 'to level the ground'}`;
      if (!this.affordable(plan)) {
        html += `${SEP}not enough money`;
        bad = true;
      } else if (plan.bad.length && plan.reason) {
        // Why, in the reason's words: '1 blocked: something is already here'.
        const why = /^[A-Z][a-z]/.test(plan.reason) ? plan.reason[0].toLowerCase() + plan.reason.slice(1) : plan.reason;
        html += `${SEP}${plan.bad.length} blocked: ${why}`;
      }
    }
    this.ui.cursorTip(sx, sy, html, bad);
  }

  pointerDown(fx: number, fy: number, sx: number, sy: number): void {
    if (this.mode === 'title') return;
    this.audio.unlock();
    this.built = null;
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    const t = this.tool();
    const inside = this.world.inBounds(tx, ty);
    switch (t.kind) {
      case 'click':
        if (!inside) return;
        if (t.id === 'query') this.ui.inspect(tx, ty);
        else if (t.id === 'spring') this.pendingPlace = true;
        else if (t.id === 'pan') this.ui.cursorTip(sx, sy, `<span class="num">${Math.round(this.world.height[ty * this.world.w + tx])} m</span>`);
        return;
      case 'place':
        // Build when the pointer lifts, so a pinch that starts here builds nothing.
        if (inside) this.pendingPlace = true;
        return;
      case 'brush':
        if (!inside) return;
        this.strokeRedo = this.redoStack;
        this.pushUndo();
        if (this.mode === 'city') this.undoStack[this.undoStack.length - 1].within = null;
        this.brushOn = true;
        this.brushAt = { x: fx, y: fy };
        this.brushSpent = 0;
        this.brushTarget = this.world.height[ty * this.world.w + tx];
        if (t.id === 'level' && this.world.water[ty * this.world.w + tx]) this.brushTarget = Math.max(0.5, this.brushTarget);
        // The ring and the tip show from the start, also for a finger held still, which sends no moves.
        this.brushScreen = { x: sx, y: sy };
        this.pointerMove(fx, fy, sx, sy);
        return;
      default:
        if (!inside) return;
        this.anchor = { x: tx, y: ty };
        this.pointerMove(fx, fy, sx, sy);
    }
  }

  pointerUp(fx: number, fy: number, sx: number, sy: number): void {
    this.releasePointer(fx, fy, sx, sy);
    if (this.toolOnce) {
      this.toolOnce = null;
      this.anchor = null;
      this.pointerMove(fx, fy, sx, sy);
    }
  }

  private releasePointer(fx: number, fy: number, sx: number, sy: number): void {
    if (this.brushOn) {
      this.brushOn = false;
      this.minimap.markDirty();
      if (this.mode === 'city') this.setUndoCost(this.brushSpent);
      if (Math.round(this.brushSpent) >= 1) this.ui.toast(`Levelled for ${fmtMoney(this.brushSpent)}`);
      return;
    }
    if (this.pendingPlace) {
      this.pendingPlace = false;
      const tx = Math.floor(fx);
      const ty = Math.floor(fy);
      const t = this.tool();
      if (this.world.inBounds(tx, ty)) {
        if (t.id === 'spring') this.dropSpring(tx, ty);
        else {
          const plan = this.plan(tx, ty);
          if (plan) this.commit(plan, tx, ty);
        }
      }
      this.pointerMove(fx, fy, sx, sy);
      return;
    }
    if (!this.anchor) return;
    const plan = this.plan(Math.floor(fx), Math.floor(fy));
    this.anchor = null;
    if (plan) this.commit(plan, Math.floor(fx), Math.floor(fy));
    this.pointerMove(fx, fy, sx, sy);
  }

  private dropSpring(tx: number, ty: number): void {
    this.pushUndo();
    const n = addSpring(this.world, tx, ty);
    if (n) {
      this.audio.play('terrain');
      this.minimap.markDirty();
    } else {
      this.undoStack.pop();
      this.ui.syncUndo();
      this.ui.toast('The water had nowhere to go.', 'warn');
    }
  }

  /** Whether the city can pay for a plan. Bulldozing goes ahead even in debt, so a broke city can cut its upkeep. */
  private affordable(plan: Plan): boolean {
    return this.mode !== 'city' || this.tool().id === 'bulldoze' || plan.cost <= this.world.city.funds;
  }

  /** Carry out a plan, the pointer having lifted on tile (tx, ty). */
  private commit(plan: Plan, tx: number, ty: number): void {
    const t = this.tool();
    if (!plan.count) {
      if (plan.reason) this.ui.toast(plan.reason, 'warn');
      this.audio.play('error');
      return;
    }
    const city = this.world.city;
    if (!this.affordable(plan)) return this.notEnough(plan.cost);
    const spot = this.footprint(t, plan);
    if (this.world.inBounds(tx, ty)) spot.add(ty * this.world.w + tx);
    this.pushUndo();
    if (t.kind === 'line') applyLine(this.world, t.net!, plan);
    else if (t.id === 'bulldoze') {
      this.raiseDust(plan);
      applyBulldoze(this.world, plan);
    } else if (t.id === 'trees') applyTrees(this.world, plan);
    else if (t.building) applyBuildings(this.world, t.building as Kind, plan);
    // A small, short puff where a plant or a service goes up.
    if (t.kind === 'place') {
      const size = BUILDINGS[t.building!].size;
      for (const [x, y] of plan.tiles.slice(0, 8)) this.renderer.vehicles.addDust(x + size / 2, y + size / 2, 0.6);
    }
    if (this.mode === 'city') {
      city.funds -= plan.cost;
      this.setUndoCost(plan.cost);
      this.built = { html: this.builtText(t, plan), until: performance.now() + 1200, tiles: spot, shown: true };
    }
    this.sealUndo();
    if (this.sim) this.sim.powerDirty = true;
    this.minimap.markDirty();
    this.audio.play(t.id === 'bulldoze' ? 'bulldoze' : t.kind === 'zone' ? 'zone' : 'build');
    this.ui.onFunds();
  }

  /**
   * The tiles a plan builds on (or clears), before it is carried out, and around them as far as another of the same
   * would overlap it: there a preview could only say the spot is taken.
   */
  private footprint(t: ToolDef, plan: Plan): Set<number> {
    const w = this.world;
    const tiles = new Set<number>();
    const add = (x0: number, y0: number, s: number) => {
      for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) if (w.inBounds(x, y)) tiles.add(y * w.w + x);
    };
    const size = t.building ? BUILDINGS[t.building].size : 1;
    const m = size - 1;
    for (const [x, y] of plan.tiles) {
      const b = t.id === 'bulldoze' ? w.buildingAt(x, y) : undefined;
      if (b) add(b.x, b.y, b.size);
      else add(x - m, y - m, size + 2 * m);
    }
    return tiles;
  }

  /** What the tip says once a plan is built: 'Zoned 11 lots · $1,100', 'Road · 9 tiles · $90', 'Cleared 4 · $4'. */
  private builtText(t: ToolDef, plan: Plan): string {
    const n = plan.count;
    const cost = `<span class="num">${fmtMoney(plan.cost)}</span>`;
    if (t.id === 'bulldoze') return `Cleared ${n}${SEP}${cost}`;
    if (t.kind === 'zone') return `Zoned ${n} lot${n > 1 ? 's' : ''}${SEP}${cost}`;
    if (t.kind === 'place') return `${BUILDINGS[t.building!].name} built${SEP}${cost}`;
    return `${t.name}${SEP}${n} tile${n > 1 ? 's' : ''}${SEP}${cost}`;
  }

  /** Dust where the bulldozer takes down buildings: one cloud each, eight at most. Empty lots raise none. */
  private raiseDust(plan: Plan): void {
    const seen = new Set<Building>();
    for (const [x, y] of plan.tiles) {
      const b = this.world.buildingAt(x, y);
      if (b && !(isZone(b.kind) && b.level === 0)) seen.add(b);
      if (seen.size >= 8) break;
    }
    for (const b of seen) this.renderer.vehicles.addDust(b.x + b.size / 2, b.y + b.size / 2);
  }

  /** Whether the tip is saying what was just built, which a lifted finger leaves up for its moment. */
  get showingBuilt(): boolean {
    return !!this.built?.shown;
  }

  private notEnough(cost: number): void {
    const funds = this.world.city.funds;
    const has = Math.round(funds) < 0 ? `is ${fmtMoney(-funds)} in debt` : `has ${fmtMoney(funds)}`;
    this.ui.toast(`Not enough money. That costs ${fmtMoney(cost)} and the city ${has}.`, 'warn');
    this.audio.play('error');
  }

  // ---- landmark upgrades -----------------------------------------------------

  /** A landmark's next upgrade, offered on the city's most upgraded one of its kind (the only one that counts). */
  upgradeFor(b: Building): Upgrade | undefined {
    const up = this.mode === 'city' ? nextUpgrade(b) : undefined;
    // Undo and redo put back a copy of the building, so one held from before them is no longer the one on the map.
    if (!up || this.world.buildings.get(b.id) !== b) return undefined;
    for (const o of this.world.buildings.values()) if (o.kind === b.kind && o.level > b.level) return undefined;
    return up;
  }

  /** Pay for a landmark's next upgrade. It can be undone like any action, refunded within three months. */
  upgrade(b: Building): boolean {
    const up = this.upgradeFor(b);
    if (!up) return false;
    const city = this.world.city;
    if (up.cost > city.funds) {
      this.notEnough(up.cost);
      return false;
    }
    this.sealUndo();
    const area = { x0: b.x, y0: b.y, x1: b.x + b.size - 1, y1: b.y + b.size - 1, mask: new Uint8Array(b.size * b.size).fill(1) };
    const entry: UndoEntry = { snap: this.world.areaSnapshot(area), cost: up.cost, month: city.month, upgrade: true };
    this.undoStack.push(entry);
    if (this.undoStack.length > 25) this.undoStack.shift();
    this.redoStack = [];
    city.funds -= up.cost;
    const was = buildingName(b).toLowerCase();
    this.world.setLevel(b, b.level + 1);
    entry.after = this.world.areaSnapshot(area);
    const now = buildingName(b).toLowerCase();
    const text = `The ${was} is now ${article(now)} ${now}. Land value is up across the city.`;
    this.ui.toast(text);
    this.sim?.say('upgrade', text, 'good', { x: b.x + b.size / 2, y: b.y + b.size / 2 }, 0);
    // Land value rises at once rather than at the month's end.
    this.sim?.computeMaps();
    this.renderer.refreshOverlay();
    this.minimap.markDirty();
    this.audio.play('fanfare');
    this.ui.syncUndo();
    this.ui.onFunds();
    return true;
  }

  private brushTick(dt: number): void {
    const t = this.tool();
    if (t.kind !== 'brush') {
      this.brushOn = false;
      return;
    }
    const city = this.mode === 'city';
    if (city && this.world.city.funds <= 0) {
      this.brushOn = false;
      this.ui.toast('Out of money for levelling.', 'warn');
      return;
    }
    const saved = city ? this.world.height.slice() : null;
    const res = applyBrush(this.world, t.id, this.brushAt.x, this.brushAt.y, {
      radius: this.brush.radius,
      strength: city ? 0.8 : this.brush.strength,
      dt,
      target: t.id === 'flatten' || t.id === 'level' ? this.brushTarget : undefined,
      protectBuilt: city,
    });
    if (city) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (top?.open) {
        const b = top.within;
        top.within = b
          ? { x0: Math.min(b.x0, res.x0), y0: Math.min(b.y0, res.y0), x1: Math.max(b.x1, res.x1), y1: Math.max(b.y1, res.y1) }
          : { x0: res.x0, y0: res.y0, x1: res.x1, y1: res.y1 };
      }
      const cost = res.moved * GRADE_COST;
      if (cost > this.world.city.funds) {
        // Too dear: put the ground back and stop.
        this.world.height.set(saved!);
        this.world.dirty(res.x0 - 1, res.y0 - 1, res.x1 + 1, res.y1 + 1, true);
        this.brushOn = false;
        this.setUndoCost(this.brushSpent);
        this.ui.toast('Not enough money to keep levelling.', 'warn');
        return;
      }
      this.world.city.funds -= cost;
      this.brushSpent += cost;
    }
    if (res.moved > 0.01 || t.id === 'water' || t.id === 'land' || t.id === 'forest' || t.id === 'clear') {
      this.audio.play('terrain');
      this.minimap.markDirty();
    }
    // The running cost (or the height) while the brush is held, moving or not.
    if (this.brushOn) this.pointerMove(this.brushAt.x, this.brushAt.y, this.brushScreen.x, this.brushScreen.y);
  }

  // ---- undo ---------------------------------------------------------------------

  clearUndo(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.ui?.syncUndo();
  }

  pushUndo(): void {
    if (!this.world) return;
    this.sealUndo();
    this.undoStack.push({
      snap: this.world.snapshot(), cost: 0, month: this.world.city.month, open: this.mode === 'city',
    });
    if (this.undoStack.length > (this.mode === 'editor' ? 40 : 25)) this.undoStack.shift();
    this.redoStack = [];
    this.ui?.syncUndo();
  }

  /**
   * Cut the newest entry down to the area its action changed. In a city this
   * has to happen before the simulation moves on, so that undo later puts back
   * only that area and leaves growth everywhere else alone.
   */
  private sealUndo(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (!top?.open) return;
    top.open = false;
    const full = top.snap as WorldSnapshot;
    // A brush stroke stays open while the clock runs: a lot that burned down under it meanwhile is no part of it.
    if (top.within) this.world.adoptBuilt(full, top.within);
    const area = top.within === null ? null : this.world.changedArea(full, top.within);
    if (!area) {
      this.undoStack.pop();
      this.ui?.syncUndo();
      return;
    }
    top.snap = this.world.areaSnapshot(area, full);
    top.after = this.world.areaSnapshot(area);
  }

  /**
   * Whether an entry's area has been wrecked since it was made, by a disaster or by underfunded roads crumbling: a
   * wrecked landmark can't be bought back, nor its price refunded. Then the entry goes, and so does the redo list,
   * which may build on it.
   */
  private overtaken(e: UndoEntry, verb: string): boolean {
    if (!e.after || this.world.sameTiles(e.after)) return false;
    this.redoStack = [];
    this.ui.syncUndo();
    this.ui.toast(`That spot has been wrecked since, so it can't be ${verb}.`, 'warn');
    return true;
  }

  /** What an area holds now, after an undo or redo put it back, for the entry on the other stack. */
  private afterOf(s: WorldSnapshot | AreaSnapshot): AreaSnapshot | undefined {
    return 'x0' in s ? this.world.areaSnapshot(s) : undefined;
  }

  private refundable(e: UndoEntry): boolean {
    return this.world.city.month - e.month <= REFUND_MONTHS;
  }

  /** A copy of what is there now, in the same shape as `s`, for the opposite stack. */
  private copyLike(s: WorldSnapshot | AreaSnapshot): WorldSnapshot | AreaSnapshot {
    return 'x0' in s ? this.world.areaSnapshot(s) : this.world.snapshot();
  }

  /** Record what the most recent undoable action cost, so undo refunds exactly that. */
  private setUndoCost(cost: number): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.cost = cost;
  }

  undo(): void {
    this.sealUndo();
    const e = this.undoStack.pop();
    if (!e) {
      this.ui.toast('Nothing to undo.');
      return;
    }
    if (this.overtaken(e, 'undone')) return;
    const city = this.mode === 'city';
    // Money back only for a quick change of mind, or undo would be free rental.
    const refund = city && this.refundable(e) ? e.cost : 0;
    const back = this.copyLike(e.snap);
    if (!this.restore(e.snap)) return;
    // Both stacks keep the month of the action itself, so undoing and redoing never restarts the refund clock.
    this.redoStack.push({ snap: back, cost: refund, month: e.month, upgrade: e.upgrade, after: this.afterOf(e.snap) });
    if (e.upgrade) this.sim?.computeMaps();
    this.ui.syncUndo();
    if (city) {
      this.world.city.funds += refund;
      if (e.cost >= 1 && !refund) this.ui.toast(`Undone. It cost ${fmtMoney(e.cost)}, which is only refunded within ${REFUND_MONTHS} months.`);
    }
    this.ui.onFunds();
    this.ui.refreshInspect();
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    if (this.overtaken(e, 'redone')) return;
    if (this.mode === 'city' && e.cost > this.world.city.funds) {
      this.redoStack.push(e);
      this.ui.toast('Not enough money to redo that.', 'warn');
      return;
    }
    const back = this.copyLike(e.snap);
    if (!this.restore(e.snap)) return;
    this.undoStack.push({ snap: back, cost: e.cost, month: e.month, upgrade: e.upgrade, after: this.afterOf(e.snap) });
    if (e.upgrade) this.sim?.computeMaps();
    this.ui.syncUndo();
    if (this.mode === 'city') this.world.city.funds -= e.cost;
    this.ui.onFunds();
    this.ui.refreshInspect();
  }

  private restore(s: WorldSnapshot | AreaSnapshot): boolean {
    if (!('x0' in s ? this.world.restoreArea(s) : this.world.restore(s))) {
      this.clearUndo();
      return false;
    }
    if (this.sim) {
      this.sim.powerDirty = true;
      this.sim.refreshTerrainAppeal();
    }
    this.minimap.markDirty();
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  cityTitle(): { name: string; sub: string } {
    if (this.mode === 'editor') return { name: 'Terrain editor', sub: this.terrain.seed };
    const pop = this.sim?.stats.residents ?? 0;
    return { name: this.world.city.name, sub: `Pop ${pop.toLocaleString()} · ${cityClass(pop)}` };
  }
}

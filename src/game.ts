// Game controller: modes, the tool state machine, money, undo, the clock.
import { Audio } from './audio';
import {
  BUILDINGS, CITY_CLASSES, CITY_TOOLS, DIFFICULTIES, Difficulty, EDITOR_TOOLS, GRADE_COST, Kind, MAP_SIZES, ToolDef, cityClass,
} from './defs';
import { Minimap } from './render/minimap';
import { Renderer, SLOPE_CLASSES } from './render/renderer';
import { hashString, makeRng, pick, randomSeedName } from './rng';
import { SaveFile, loadSlot, saveSlot, worldFrom } from './save';
import { SCENARIOS, buildScenario } from './scenarios';
import { Sim } from './sim';
import { DEFAULT_TERRAIN, TerrainParams, TerrainStyle, addSpring, applyBrush, generateTerrain } from './terrain';
import {
  Plan, applyBuildings, applyBulldoze, applyLine, applyTrees, linePath, planBulldoze, planLine, planParks, planPlace,
  planTrees, planZones, rectTiles,
} from './tools';
import type { UI } from './ui/ui';
import { World, WorldSnapshot, newCityState } from './world';

export type Mode = 'title' | 'editor' | 'city';

interface UndoEntry {
  snap: WorldSnapshot;
  cost: number;
}

/** Simulated weeks per real second at each speed. */
export const SPEEDS = [0, 0.7, 1.8, 5, 14];
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
  private brushTarget: number | undefined;
  private brushSpent = 0;
  private autoTimer = 0;
  private titleDrift = { vx: 1.3, vy: 0.5 };

  constructor(canvas: HTMLCanvasElement, minimapCanvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.minimap = new Minimap(minimapCanvas, this.renderer);
    const size = MAP_SIZES[1];
    this.terrain = { ...DEFAULT_TERRAIN, seed: randomSeedName(), w: size.w, h: size.h };
    this.loadSettings();
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
    this.ui.toast('Drag to move the map, scroll or pinch to zoom. Pick a brush on the left to shape the land.');
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
    this.ui.toast('Drag to move the map, scroll or pinch to zoom. Pick a brush on the left to shape the land.');
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
    this.speed = 2;
    this.clearUndo();
    this.slotId = null;
    this.applySettings();
    this.setTool('query');
    this.ui.enterCity();
    this.sim!.say('welcome', `Welcome to ${w.city.name}. Build a power plant, zone residential, commercial and industrial land, and connect it all with roads and power lines.`, 'good', undefined, 0);
    this.renderer.cam.zoom = Math.max(this.renderer.cam.zoom, 14);
    this.renderer.clampCamera();
    this.audio.play('fanfare');
  }

  private setSim(sim: Sim | null): void {
    this.sim?.dispose();
    this.sim = sim;
  }

  private startSim(): void {
    const sim = new Sim(this.world);
    this.setSim(sim);
    this.renderer.setWorld(this.world, sim);
    this.minimap.markDirty();
    sim.on((e) => {
      switch (e.type) {
        case 'message':
          this.ui.onMessage(e.message);
          if (e.message.kind === 'alert') this.audio.play('alert');
          if (e.message.kind === 'good' && e.message.text.includes('is now a')) this.audio.play('fanfare');
          break;
        case 'destroyed':
          this.renderer.vehicles.addDust(e.x, e.y);
          break;
        case 'month':
          // Undo reaches back to the start of the month; after that the
          // simulation has moved on and undo would rewrite history.
          if (this.canUndo() || this.canRedo()) this.clearUndo();
          this.minimap.markDirty();
          this.renderer.refreshOverlay();
          this.ui.onMonth();
          this.checkScenario();
          break;
        case 'year':
          this.audio.play('coin');
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
    for (let k = 0; k < 3; k++) {
      sim.computeTraffic();
      sim.computeMaps();
    }
    sim.tally();
    sim.evaluate();
    // A ready-made city starts at its own size class, without the fanfare.
    this.world.city.classReached = CITY_CLASSES.reduce((acc, c, i) => (sim.stats.residents >= c.min ? i : acc), 0);
    this.mode = 'city';
    this.speed = 2;
    this.clearUndo();
    this.slotId = null;
    this.applySettings();
    this.setTool('query');
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
    s.start?.(sim);
    this.minimap.markDirty();
    this.checkScenario();
    this.ui.scenarioIntro(s);
  }

  private checkScenario(): void {
    const sc = this.world.city.scenario;
    if (!sc || !this.sim) return;
    const s = SCENARIOS.find((x) => x.id === sc.id);
    if (!s) return;
    const month = this.world.city.month;
    if (!sc.done) s.monthly?.(this.sim);
    const st = s.check(this.sim);
    this.ui.updateGoal(s, st, sc.end - month, sc.done);
    if (sc.done) return;
    if ((s.kind === 'reach' && st.met) || month >= sc.end) {
      sc.done = st.met ? 'won' : 'lost';
      this.audio.play(st.met ? 'fanfare' : 'error');
      this.ui.updateGoal(s, st, sc.end - month, sc.done);
      this.ui.scenarioResult(s, st, sc.done === 'won');
    }
  }

  loadFile(file: SaveFile, slotId: string | null = null): void {
    this.world = worldFrom(file);
    if (file.terrain) this.terrain = { ...this.terrain, ...(file.terrain as Partial<TerrainParams>), w: this.world.w, h: this.world.h };
    else this.terrain = { ...this.terrain, w: this.world.w, h: this.world.h };
    this.clearUndo();
    this.slotId = slotId;
    if (file.mode === 'city' && this.world.city.founded) {
      this.mode = 'city';
      this.startSim();
      this.speed = 2;
      this.setTool('query');
      this.applySettings();
      this.ui.enterCity();
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

  makeSaveFile(): SaveFile {
    return {
      v: 1,
      world: this.world.serialize(),
      cam: { ...this.renderer.cam },
      mode: this.mode === 'city' ? 'city' : 'editor',
      terrain: this.terrain,
    };
  }

  async autosave(): Promise<boolean> {
    if (this.mode !== 'city') return true;
    return saveSlot('auto', this.makeSaveFile(), this.sim?.stats.residents ?? 0);
  }

  async saveTo(id: string): Promise<boolean> {
    const ok = await saveSlot(id, this.makeSaveFile(), this.sim?.stats.residents ?? 0);
    if (ok) this.slotId = id;
    return ok;
  }

  async continueAuto(): Promise<boolean> {
    const f = await loadSlot('auto');
    if (!f) return false;
    this.loadFile(f, 'auto');
    return true;
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
    const running = this.mode === 'city' && !!this.sim && this.speed > 0 && !this.ui.modalOpen;
    if (running && this.sim) {
      this.acc += dt * SPEEDS[this.speed];
      let steps = 0;
      while (this.acc >= 1 && steps < 6) {
        this.sim.step();
        this.acc -= 1;
        steps++;
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
    if (this.mode === 'city' && this.settings.autosave) {
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
      this.ui.toast('Nothing to bulldoze there.');
      return;
    }
    this.toolOnce = 'bulldoze';
    this.commit(plan);
    this.toolOnce = null;
    this.pointerMove(fx, fy, sx, sy);
  }

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
    this.renderer.preview = null;
    this.ui?.syncTool();
  }

  cancelTool(): void {
    this.toolOnce = null;
    this.anchor = null;
    this.pendingPlace = false;
    if (this.brushOn && this.mode === 'city') this.setUndoCost(this.brushSpent);
    this.brushOn = false;
    this.renderer.preview = null;
    this.ui.cursorTip(0, 0, null);
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
      r.preview = { tiles: [], bad: [], rects: [], brush: { x: fx, y: fy, r: this.brush.radius } };
      if (this.mode === 'editor' && inside) {
        this.ui.cursorTip(sx, sy, `<span class="num">${Math.round(this.world.height[ty * this.world.w + tx])} m</span>`);
      } else if (t.id === 'level' && inside) {
        const s = this.world.slope(tx, ty);
        const cls = SLOPE_CLASSES.find((c) => s <= c.max)!;
        const spent = this.brushOn ? `Levelling <span class="num">${fmtMoney(this.brushSpent)}</span> · ` : 'Hold to level · ';
        this.ui.cursorTip(sx, sy, `${spent}<b>${cls.label}</b> (<span class="num">${s.toFixed(1)} m</span>): ${cls.note}`, false);
      }
      return;
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
    const funds = this.world.city.funds;
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
      html = `${t.kind === 'place' ? '' : t.name + ' · '}${what} · <span class="num">${fmtMoney(plan.cost)}</span>`;
      if (plan.grading) html += ` · includes <span class="num">${fmtMoney(plan.grading)}</span> ${t.kind === 'line' ? 'to grade the slope' : 'to level the ground'}`;
      if (plan.cost > funds) {
        html += ' · not enough money';
        bad = true;
      } else if (plan.bad.length && plan.reason) {
        html += ` · ${plan.bad.length} blocked`;
      }
    }
    this.ui.cursorTip(sx, sy, html, bad);
  }

  pointerDown(fx: number, fy: number, sx: number, sy: number): void {
    if (this.mode === 'title') return;
    this.audio.unlock();
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
        this.pushUndo();
        this.brushOn = true;
        this.brushAt = { x: fx, y: fy };
        this.brushSpent = 0;
        this.brushTarget = this.world.height[ty * this.world.w + tx];
        if (t.id === 'level' && this.world.water[ty * this.world.w + tx]) this.brushTarget = Math.max(0.5, this.brushTarget);
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
      if (this.brushSpent > 0) this.ui.toast(`Levelled for ${fmtMoney(this.brushSpent)}`);
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
          if (plan) this.commit(plan);
        }
      }
      this.pointerMove(fx, fy, sx, sy);
      return;
    }
    if (!this.anchor) return;
    const plan = this.plan(Math.floor(fx), Math.floor(fy));
    this.anchor = null;
    if (plan) this.commit(plan);
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

  private commit(plan: Plan): void {
    const t = this.tool();
    if (!plan.count) {
      if (plan.reason) this.ui.toast(plan.reason, 'warn');
      this.audio.play('error');
      return;
    }
    const city = this.world.city;
    if (this.mode === 'city' && plan.cost > city.funds) {
      this.ui.toast(`Not enough money. That costs ${fmtMoney(plan.cost)} and the city has ${fmtMoney(city.funds)}.`, 'warn');
      this.audio.play('error');
      return;
    }
    this.pushUndo();
    if (t.kind === 'line') applyLine(this.world, t.net!, plan);
    else if (t.id === 'bulldoze') applyBulldoze(this.world, plan);
    else if (t.id === 'trees') applyTrees(this.world, plan);
    else if (t.building) applyBuildings(this.world, t.building as Kind, plan);
    if (this.mode === 'city') {
      city.funds -= plan.cost;
      this.setUndoCost(plan.cost);
    }
    if (this.sim) this.sim.powerDirty = true;
    this.minimap.markDirty();
    this.audio.play(t.id === 'bulldoze' ? 'bulldoze' : t.kind === 'zone' ? 'zone' : 'build');
    this.ui.onFunds();
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
  }

  // ---- undo ---------------------------------------------------------------------

  clearUndo(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.ui?.syncUndo();
  }

  pushUndo(): void {
    if (!this.world) return;
    this.undoStack.push({ snap: this.world.snapshot(), cost: 0 });
    if (this.undoStack.length > (this.mode === 'editor' ? 40 : 25)) this.undoStack.shift();
    this.redoStack = [];
    this.ui?.syncUndo();
  }

  /** Record what the most recent undoable action cost, so undo refunds exactly that. */
  private setUndoCost(cost: number): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.cost = cost;
  }

  undo(): void {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push({ snap: this.world.snapshot(), cost: e.cost });
    this.restore(e.snap);
    if (this.mode === 'city') this.world.city.funds += e.cost;
    this.ui.onFunds();
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    if (this.mode === 'city' && e.cost > this.world.city.funds) {
      this.redoStack.push(e);
      this.ui.toast('Not enough money to redo that.', 'warn');
      return;
    }
    this.undoStack.push({ snap: this.world.snapshot(), cost: e.cost });
    this.restore(e.snap);
    if (this.mode === 'city') this.world.city.funds -= e.cost;
    this.ui.onFunds();
  }

  private restore(s: WorldSnapshot): void {
    if (!this.world.restore(s)) {
      this.clearUndo();
      return;
    }
    if (this.sim) {
      this.sim.powerDirty = true;
      this.sim.refreshTerrainAppeal();
    }
    this.minimap.markDirty();
    this.ui.syncUndo();
    this.ui.onFunds();
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

// Everything in the DOM: top bar, toolbox, panels, dialogs, title screen.
import { BUILDINGS, DIFFICULTIES, Difficulty, Kind, MAP_SIZES, ToolDef, cityClass, dateLabel, isZone } from '../defs';
import { DISASTER_NAMES, DisasterKind } from '../disasters';
import { Game, SPEED_NAMES, randomCityName } from '../game';
import { OVERLAYS, Overlay, SLOPE_CLASSES } from '../render/renderer';
import { ZONE_COLORS } from '../render/color';
import { drawBuilding } from '../render/sprites';
import { randomSeedName } from '../rng';
import { SaveFile, decode, deleteSlot, encode, listSlots, loadSlot, storageAvailable } from '../save';
import type { Message } from '../sim';
import { STYLE_NAMES, TerrainStyle, hasSea } from '../terrain';
import { GoalState, SCENARIOS, Scenario } from '../scenarios';
import { World } from '../world';
import { lineChart } from './charts';
import { buildGuide, trackGuide } from './guide';
import { ICONS } from './icons';

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T => root.querySelector(sel) as T;

function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function money(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString();
}

/** Build the static shell and return the two canvases the game needs. */
export function buildShell(root: HTMLElement): { map: HTMLCanvasElement; minimap: HTMLCanvasElement } {
  root.innerHTML = `
    <canvas id="map" aria-label="City map"></canvas>
    <header id="topbar"></header>
    <nav id="toolbox" class="panel" aria-label="Tools"></nav>
    <aside id="editorPanel" class="panel" hidden></aside>
    <aside id="guide" class="panel" hidden></aside>
    <aside id="goal" class="panel" hidden></aside>
    <div id="minimapCard" class="panel">
      <canvas id="minimap" aria-label="Overview map"></canvas>
      <div class="mm-row">
        <select id="overlaySel" aria-label="Map layer"></select>
        <button class="iconbtn" id="zoomOut" aria-label="Zoom out">${ICONS.minus}</button>
        <button class="iconbtn" id="zoomIn" aria-label="Zoom in">${ICONS.plus}</button>
      </div>
      <div class="legend" id="legend" hidden></div>
    </div>
    <div id="ticker" class="panel"></div>
    <div id="log" class="panel" hidden></div>
    <div id="inspect" class="panel" hidden></div>
    <div id="tooltip" class="panel" hidden></div>
    <div id="cursorTip" hidden></div>
    <div id="toast" class="panel hide" role="status" aria-live="polite"></div>
    <div id="dropRoot"></div>
    <div id="modalRoot" hidden></div>
    <section id="title" hidden></section>`;
  return { map: $(root, '#map'), minimap: $(root, '#minimap') };
}

interface ModalSpec {
  title: string;
  sub?: string;
  body: HTMLElement;
  foot?: HTMLElement[];
  onClose?: () => void;
  wide?: boolean;
  /** Maximum width in pixels, for dialogs wider than `wide`. */
  width?: number;
}

export class UI {
  modalOpen = false;
  private statTimer = 0;
  private toastTimer = 0;
  private inspectAt: { x: number; y: number } | null = null;
  private modalClose: (() => void) | null = null;
  private dropdownEl: HTMLElement | null = null;
  private dropdownBtn: HTMLElement | null = null;
  private lastMessage: Message | null = null;
  private regenTimer = 0;
  private guideDismissed = false;
  private guideTimer = 0;
  private chartRange = 120;

  constructor(private game: Game, private root: HTMLElement) {
    this.buildMinimapControls();
    $(root, '#modalRoot').addEventListener('pointerdown', (e) => {
      if (e.target === e.currentTarget) this.closeModal();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.dropdownEl) return;
      const t = e.target as Node;
      if (this.dropdownEl.contains(t) || this.dropdownBtn?.contains(t)) return;
      this.closeDropdown();
    });
    window.addEventListener('resize', () => this.closeDropdown());
    try {
      this.guideDismissed = localStorage.getItem('terraville.guide') === 'done';
    } catch {
      /* ignore */
    }
  }

  // ---- mode switches ----------------------------------------------------------

  enterTitle(): void {
    this.closeModal();
    this.closeDropdown();
    for (const id of ['#topbar', '#toolbox', '#editorPanel', '#minimapCard', '#ticker', '#log', '#inspect', '#guide', '#goal']) $(this.root, id).hidden = true;
    const t = $(this.root, '#title');
    t.hidden = false;
    const auto = listSlots().find((s) => s.id === 'auto');
    t.innerHTML = `
      <div class="title-inner">
        <div class="bigsign" role="img" aria-label="Terraville, established 1900">
          <div class="name">TERRAVILLE</div>
          <div class="est">Est. 1900</div>
        </div>
        <p class="lede">Shape a landscape, then grow a city on it. Zone homes, shops and factories, string the power lines, balance the books, and keep an eye on the sky.</p>
        <div class="title-actions">
          <button class="btn primary" data-act="quick"><span>Start a new city</span><small>Random land</small></button>
          <button class="btn" data-act="editor"><span>Shape the land first</span><small>Terrain editor</small></button>
          <button class="btn" data-act="challenges"><span>Challenges</span><small>Cities in trouble</small></button>
          <button class="btn" data-act="guide"><span>Strategy guide</span><small>How cities grow</small></button>
          ${auto ? `<button class="btn" data-act="continue"><span>Continue ${esc(auto.name)}</span><small class="num">${dateLabel(auto.date)} · pop ${auto.pop.toLocaleString()}</small></button>` : ''}
          <button class="btn" data-act="open"><span>Open a saved city</span><small>Saves and city codes</small></button>
        </div>
        <div class="title-foot">A city builder in the spirit of the 1989 classic and its terrain editor. Best with a mouse; touch works too.</div>
      </div>`;
    t.onclick = async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) return;
      this.game.audio.unlock();
      this.game.audio.play('click');
      const act = b.dataset.act;
      if (act === 'quick') this.game.quickStart();
      else if (act === 'editor') this.game.startEditor({ seed: randomSeedName() });
      else if (act === 'challenges') this.openChallenges();
      else if (act === 'guide') this.openGuide();
      else if (act === 'continue') {
        if (!(await this.game.continueAuto())) this.toast('That save could not be opened.', 'warn');
      } else if (act === 'open') this.openFiles();
    };
  }

  private showChrome(): void {
    $(this.root, '#title').hidden = true;
    for (const id of ['#topbar', '#toolbox', '#minimapCard']) $(this.root, id).hidden = false;
  }

  enterEditor(): void {
    this.showChrome();
    $(this.root, '#ticker').hidden = true;
    $(this.root, '#log').hidden = true;
    $(this.root, '#guide').hidden = true;
    $(this.root, '#goal').hidden = true;
    this.hideInspect();
    this.buildTopbarEditor();
    this.buildToolbox();
    this.buildEditorPanel();
    this.syncOverlay();
  }

  enterCity(): void {
    this.lastMessage = null;
    this.showChrome();
    $(this.root, '#editorPanel').hidden = true;
    $(this.root, '#ticker').hidden = false;
    this.hideInspect();
    this.buildTopbarCity();
    this.buildToolbox();
    this.renderTicker();
    this.syncOverlay();
    this.updateStats();
    $(this.root, '#goal').hidden = !this.game.world.city.scenario;
    this.updateGuide(true);
  }

  // ---- top bar -------------------------------------------------------------------

  private buildTopbarCity(): void {
    const top = $(this.root, '#topbar');
    top.innerHTML = `
      <button class="sign" id="citySign" aria-label="City report"><b id="signName"></b><small id="signSub"></small></button>
      <div class="panel stat-strip">
        <div class="stat"><span class="label">Date</span><span class="value" id="stDate"></span></div>
        <div class="stat" id="stFundsBox"><span class="label">Funds</span><span class="value" id="stFunds"></span><span class="delta" id="stDelta"></span></div>
        <div class="rci" title="Demand for residential, commercial and industrial land">
          <div class="bar"><div class="fill r" id="rciR"></div></div>
          <div class="bar"><div class="fill c" id="rciC"></div></div>
          <div class="bar"><div class="fill i" id="rciI"></div></div>
          <div class="lab">R</div><div class="lab">C</div><div class="lab">I</div>
        </div>
        <div class="speed" role="group" aria-label="Speed">
          <button class="paused" data-speed="0" aria-label="Pause" title="Pause (Space)">${ICONS.pause}</button>
          <button data-speed="1" aria-label="Slow" title="Slow">${ICONS.play1}</button>
          <button data-speed="2" aria-label="Normal" title="Normal">${ICONS.play2}</button>
          <button data-speed="3" aria-label="Fast" title="Fast">${ICONS.play3}</button>
          <button data-speed="4" aria-label="Ultra" title="Ultra">${ICONS.play4}</button>
        </div>
      </div>
      <div class="panel menu">
        <button data-act="budget" title="Budget">${ICONS.budget}<span class="label">Budget</span></button>
        <button data-act="charts" title="History">${ICONS.charts}<span class="label">History</span></button>
        <button data-act="report" class="hide-sm" title="City report">${ICONS.report}<span class="label">Report</span></button>
        <button data-act="layers" title="Map layers" aria-haspopup="true">${ICONS.layers}<span class="label">Layers</span></button>
        <button data-act="disasters" title="Disasters" aria-haspopup="true">${ICONS.disaster}<span class="label">Disasters</span></button>
        <button data-act="menu" title="Menu" aria-haspopup="true" aria-label="Menu">${ICONS.menu}</button>
      </div>`;
    top.onclick = (e) => {
      const t = e.target as HTMLElement;
      const sp = t.closest<HTMLElement>('[data-speed]');
      if (sp) {
        this.game.setSpeed(Number(sp.dataset.speed));
        this.game.audio.play('click');
        return;
      }
      if (t.closest('#citySign')) return this.openReport();
      const b = t.closest<HTMLElement>('[data-act]');
      if (!b) return;
      this.game.audio.play('click');
      switch (b.dataset.act) {
        case 'budget': return this.openBudget();
        case 'charts': return this.openCharts();
        case 'report': return this.openReport();
        case 'layers': return this.toggleDropdown(b, () => this.layersMenu());
        case 'disasters': return this.toggleDropdown(b, () => this.disasterMenu());
        case 'menu': return this.toggleDropdown(b, () => this.mainMenu());
      }
    };
    this.syncSpeed();
  }

  private buildTopbarEditor(): void {
    const top = $(this.root, '#topbar');
    top.innerHTML = `
      <div class="sign"><b>Terrain editor</b><small id="signSub"></small></div>
      <div class="panel menu" style="margin-left:0">
        <button data-act="undo" id="btnUndo" title="Undo (Ctrl+Z)" aria-label="Undo">${ICONS.undo}</button>
        <button data-act="redo" id="btnRedo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${ICONS.redo}</button>
      </div>
      <div class="panel menu">
        <button class="primary" data-act="found">${ICONS.build}<span>Found a city here</span></button>
        <button data-act="menu" title="Menu" aria-haspopup="true" aria-label="Menu">${ICONS.menu}</button>
      </div>`;
    top.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) return;
      this.game.audio.play('click');
      switch (b.dataset.act) {
        case 'undo': return this.game.undo();
        case 'redo': return this.game.redo();
        case 'found': return this.openFound(false);
        case 'menu': return this.toggleDropdown(b, () => this.mainMenu());
      }
    };
    $(this.root, '#signSub').textContent = this.game.terrain.seed;
    this.syncUndo();
  }

  syncSpeed(): void {
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-speed]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === this.game.speed));
    }
  }

  syncUndo(): void {
    const u = this.root.querySelector<HTMLButtonElement>('#btnUndo');
    const r = this.root.querySelector<HTMLButtonElement>('#btnRedo');
    if (u) u.disabled = !this.game.canUndo();
    if (r) r.disabled = !this.game.canRedo();
    if (u) u.style.opacity = u.disabled ? '0.4' : '';
    if (r) r.style.opacity = r.disabled ? '0.4' : '';
  }

  private updateStats(): void {
    const g = this.game;
    if (g.mode !== 'city' || !g.sim) return;
    const city = g.world.city;
    const s = g.sim.stats;
    const set = (id: string, v: string) => {
      const e = this.root.querySelector('#' + id);
      if (e && e.textContent !== v) e.textContent = v;
    };
    set('signName', city.name);
    set('signSub', `Pop ${s.residents.toLocaleString()} · ${cityClass(s.residents)}`);
    set('stDate', dateLabel(city.month));
    set('stFunds', money(city.funds));
    const b = s.lastBudget;
    const net = b.taxIncome - (b.transport + b.police + b.fire + b.services + b.power + b.interest);
    const d = this.root.querySelector('#stDelta');
    if (d) {
      d.textContent = city.month > 0 ? `${net >= 0 ? '+' : '−'}${money(Math.abs(net)).replace('−', '')}/mo` : '';
      d.className = 'delta ' + (net > 0.5 ? 'up' : net < -0.5 ? 'down' : '');
    }
    this.root.querySelector('#stFundsBox')?.classList.toggle('funds-low', city.funds < 0);
    const bar = (id: string, v: number) => {
      const e = this.root.querySelector<HTMLElement>('#' + id);
      if (!e) return;
      const h = Math.max(1, Math.abs(v) * 16);
      e.style.height = `${h}px`;
      e.style.top = v >= 0 ? `${17 - h}px` : '17px';
    };
    bar('rciR', city.demand.r);
    bar('rciC', city.demand.c);
    bar('rciI', city.demand.i);
  }

  tick(dt: number): void {
    this.statTimer -= dt;
    if (this.statTimer <= 0) {
      this.statTimer = 0.25;
      this.updateStats();
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) $(this.root, '#toast').classList.add('hide');
    }
    this.guideTimer -= dt;
    if (this.guideTimer <= 0) {
      this.guideTimer = 1;
      this.updateGuide(false);
    }
  }

  onFunds(): void {
    this.updateStats();
  }

  onMonth(): void {
    if (this.inspectAt) this.inspect(this.inspectAt.x, this.inspectAt.y, true);
  }

  // ---- toolbox -------------------------------------------------------------------

  private buildToolbox(): void {
    const box = $(this.root, '#toolbox');
    box.innerHTML = '';
    const tools = this.game.tools();
    const groups = new Map<string, ToolDef[]>();
    for (const t of tools) {
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group)!.push(t);
    }
    for (const list of groups.values()) {
      const g = el('<div class="toolgroup"></div>');
      for (const t of list) {
        const b = el<HTMLButtonElement>(`<button class="tool" data-tool="${t.id}" aria-label="${esc(t.name)}"></button>`);
        b.appendChild(this.toolIcon(t));
        if (t.key) b.appendChild(el(`<span class="key">${t.key.toUpperCase()}</span>`));
        b.addEventListener('click', () => {
          this.game.setTool(t.id);
          this.game.audio.play('click');
        });
        b.addEventListener('pointerenter', () => this.showToolTip(b, t));
        b.addEventListener('pointerleave', () => ($(this.root, '#tooltip').hidden = true));
        b.addEventListener('focus', () => this.showToolTip(b, t));
        b.addEventListener('blur', () => ($(this.root, '#tooltip').hidden = true));
        g.appendChild(b);
      }
      box.appendChild(g);
    }
    if (this.game.mode === 'editor') {
      const bb = el(`<div class="brushbox">
        <label>Brush size <input type="range" id="brushSize" min="1" max="14" step="0.5"></label>
        <label>Strength <input type="range" id="brushStrength" min="0.1" max="1.5" step="0.05"></label>
      </div>`);
      const size = $<HTMLInputElement>(bb, '#brushSize');
      const str = $<HTMLInputElement>(bb, '#brushStrength');
      size.value = String(this.game.brush.radius);
      str.value = String(this.game.brush.strength);
      size.oninput = () => (this.game.brush.radius = Number(size.value));
      str.oninput = () => (this.game.brush.strength = Number(str.value));
      box.appendChild(bb);
    }
    this.syncTool();
  }

  nudgeBrush(d: number): void {
    this.game.brush.radius = Math.max(1, Math.min(14, this.game.brush.radius + d));
    const s = this.root.querySelector<HTMLInputElement>('#brushSize');
    if (s) s.value = String(this.game.brush.radius);
  }

  private toolIcon(t: ToolDef): HTMLElement {
    if (t.building && isZone(t.building)) {
      const col = ZONE_COLORS[t.building as 'res' | 'com' | 'ind'];
      return el(`<span class="zone-badge" style="background:${col}">${t.building === 'res' ? 'R' : t.building === 'com' ? 'C' : 'I'}</span>`);
    }
    if (t.building) return this.spriteIcon(t.building);
    const svg = ICONS[t.id] ?? ICONS.query;
    return el(`<span style="display:grid">${svg}</span>`);
  }

  private spriteIcon(kind: Kind): HTMLElement {
    const def = BUILDINGS[kind];
    const px = 64;
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    const ctx = c.getContext('2d')!;
    const world = new World(8, 8);
    world.height.fill(2);
    if (kind === 'seaport') for (let x = 0; x < 8; x++) world.water[x] = 1;
    const y = kind === 'seaport' ? 1 : 0;
    const L = px / def.size;
    const b = { id: 1, kind, x: 0, y, size: def.size, level: 1, pop: 0, powered: true, seed: kind === 'park' ? 2 : 777, age: 0, road: true, trip: true };
    ctx.translate(0, -y * L);
    drawBuilding({ ctx, L, world }, b);
    return c;
  }

  private showToolTip(b: HTMLElement, t: ToolDef): void {
    const tip = $(this.root, '#tooltip');
    const cost = t.cost ? `<span class="cost">${t.kind === 'line' || t.id === 'bulldoze' || t.id === 'trees' || t.id === 'park' ? `$${t.cost} a tile` : money(t.cost)}${t.building && BUILDINGS[t.building].upkeep ? ` · ${money(BUILDINGS[t.building].upkeep)}/mo upkeep` : ''}</span>` : '';
    const zoneTip = t.building && isZone(t.building) ? `<p>${esc(BUILDINGS[t.building].blurb)} Drag to zone several 3×3 lots.</p>` : `<p>${esc(t.tip)}</p>`;
    tip.innerHTML = `<b>${esc(t.name)}${t.key ? ` <kbd>${t.key.toUpperCase()}</kbd>` : ''}</b>${cost}${zoneTip}`;
    tip.hidden = false;
    const r = b.getBoundingClientRect();
    const narrow = window.innerWidth <= 820;
    if (narrow) {
      tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 268, r.left))}px`;
      tip.style.top = `${r.top - tip.offsetHeight - 8}px`;
    } else {
      tip.style.left = `${r.right + 10}px`;
      tip.style.top = `${Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, r.top))}px`;
    }
  }

  syncTool(): void {
    for (const b of this.root.querySelectorAll<HTMLElement>('.tool')) {
      b.setAttribute('aria-pressed', String(b.dataset.tool === this.game.toolId));
    }
    const map = $(this.root, '#map');
    map.classList.toggle('grab', this.game.toolId === 'query' || this.game.toolId === 'pan');
  }

  // ---- editor panel ----------------------------------------------------------------

  private buildEditorPanel(): void {
    const p = $(this.root, '#editorPanel');
    p.hidden = false;
    const t = this.game.terrain;
    const styles = Object.keys(STYLE_NAMES) as TerrainStyle[];
    const slider = (id: string, label: string, min: number, max: number, step: number, val: number) => `
      <label class="field"><span>${label} <span class="num" id="${id}Val">${val}</span></span>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
    p.classList.toggle('collapsed', window.innerWidth <= 820);
    p.innerHTML = `
      <h2 id="edHead" style="cursor:pointer">Generate land</h2>
      <div class="field"><span>Landscape</span>
        <div class="seg" id="edStyle">${styles.map((s) => `<button data-style="${s}" aria-pressed="${s === t.style}">${STYLE_NAMES[s]}</button>`).join('')}</div>
      </div>
      <div class="field"><span>Map size</span>
        <div class="seg" id="edSize">${MAP_SIZES.map((m) => `<button data-size="${m.id}" aria-pressed="${m.w === t.w}">${m.name}<br><span class="num" style="font-weight:500;font-size:10.5px">${m.w}×${m.h}</span></button>`).join('')}</div>
      </div>
      ${slider('edWater', 'Sea', 0, 100, 1, t.water)}
      ${slider('edHills', 'Mountains', 0, 100, 1, t.hills)}
      ${slider('edRough', 'Ruggedness', 0, 100, 1, t.rough)}
      ${slider('edRivers', 'Rivers', 0, 6, 1, t.rivers)}
      ${slider('edLakes', 'Lakes', 0, 100, 1, t.lakes)}
      ${slider('edForest', 'Forest', 0, 100, 1, t.forest)}
      <div class="field"><span>Seed</span>
        <div class="seedrow"><input id="edSeed" value="${esc(t.seed)}" spellcheck="false" aria-label="Seed">
        <button class="iconbtn" id="edDice" aria-label="Random seed" title="Random seed">${ICONS.dice}</button></div>
      </div>
      <p class="note">Sliders regenerate the whole map. Sculpt afterwards with the brushes; Undo steps back through both.</p>`;
    $(p, '#edHead').onclick = () => {
      if (window.innerWidth <= 820) p.classList.toggle('collapsed');
    };
    const regen = (params: Record<string, unknown>) => {
      window.clearTimeout(this.regenTimer);
      this.regenTimer = window.setTimeout(() => {
        this.game.regenerate(params);
        $(this.root, '#signSub').textContent = this.game.terrain.seed;
        this.syncUndo();
      }, 90);
    };
    const bind = (id: string, key: string) => {
      const input = $<HTMLInputElement>(p, '#' + id);
      input.oninput = () => {
        $(p, `#${id}Val`).textContent = input.value;
        regen({ [key]: Number(input.value) });
      };
    };
    bind('edWater', 'water');
    bind('edHills', 'hills');
    bind('edRough', 'rough');
    bind('edRivers', 'rivers');
    bind('edLakes', 'lakes');
    bind('edForest', 'forest');
    const syncSea = () => {
      const on = hasSea(this.game.terrain.style);
      const input = $<HTMLInputElement>(p, '#edWater');
      input.disabled = !on;
      input.closest('.field')!.setAttribute('style', on ? '' : 'opacity:.45');
    };
    syncSea();
    $(p, '#edStyle').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-style]');
      if (!b) return;
      for (const x of p.querySelectorAll('[data-style]')) x.setAttribute('aria-pressed', String(x === b));
      this.game.terrain.style = b.dataset.style as TerrainStyle;
      syncSea();
      regen({ style: b.dataset.style });
    };
    $(p, '#edSize').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-size]');
      if (!b) return;
      const m = MAP_SIZES.find((s) => s.id === b.dataset.size)!;
      for (const x of p.querySelectorAll('[data-size]')) x.setAttribute('aria-pressed', String(x === b));
      this.game.regenerate({ w: m.w, h: m.h });
      this.syncUndo();
    };
    const seed = $<HTMLInputElement>(p, '#edSeed');
    seed.onchange = () => regen({ seed: seed.value.trim() || randomSeedName() });
    seed.onkeydown = (e) => {
      if (e.key === 'Enter') seed.blur();
    };
    $(p, '#edDice').onclick = () => {
      seed.value = randomSeedName();
      regen({ seed: seed.value });
    };
  }

  // ---- minimap and overlays --------------------------------------------------------

  private buildMinimapControls(): void {
    const sel = $<HTMLSelectElement>(this.root, '#overlaySel');
    sel.innerHTML = OVERLAYS.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
    sel.onchange = () => this.setOverlay(sel.value as Overlay);
    $(this.root, '#zoomIn').onclick = () => this.game.renderer.zoomAt(this.game.renderer.cssW / 2, this.game.renderer.cssH / 2, 1.4);
    $(this.root, '#zoomOut').onclick = () => this.game.renderer.zoomAt(this.game.renderer.cssW / 2, this.game.renderer.cssH / 2, 1 / 1.4);
    const mm = $<HTMLCanvasElement>(this.root, '#minimap');
    let dragging = false;
    const go = (e: PointerEvent) => {
      const t = this.game.minimap.toTile(e.clientX, e.clientY);
      this.game.renderer.centerOn(t.x, t.y);
    };
    mm.addEventListener('pointerdown', (e) => {
      dragging = true;
      mm.setPointerCapture(e.pointerId);
      go(e);
    });
    mm.addEventListener('pointermove', (e) => dragging && go(e));
    mm.addEventListener('pointerup', () => (dragging = false));
  }

  setOverlay(o: Overlay): void {
    if (this.game.mode === 'editor' && o !== 'none' && o !== 'slope') o = 'none';
    this.game.renderer.setOverlay(o);
    this.syncOverlay();
  }

  syncOverlay(): void {
    const sel = $<HTMLSelectElement>(this.root, '#overlaySel');
    const o = this.game.renderer.overlay;
    sel.value = o;
    const editor = this.game.mode === 'editor';
    sel.disabled = this.game.mode === 'title';
    for (const opt of sel.options) opt.disabled = editor && opt.value !== 'none' && opt.value !== 'slope';
    const def = OVERLAYS.find((x) => x.id === o)!;
    $(this.root, '#minimapCard').classList.toggle('show', o !== 'none');
    const leg = $(this.root, '#legend');
    if (o === 'none') {
      leg.hidden = true;
      return;
    }
    leg.hidden = false;
    if (o === 'slope') {
      leg.style.flexWrap = 'wrap';
      leg.innerHTML = SLOPE_CLASSES.map((c, k) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:6px" title="${c.note}"><i style="width:10px;height:10px;border-radius:3px;display:inline-block;background:${c.alpha ? `rgba(235,104,52,${c.alpha / 255})` : 'transparent'};border:1px solid var(--line-2)"></i>${c.label} <span class="num">${k < 3 ? `≤${c.max}` : `>${SLOPE_CLASSES[2].max}`} m</span></span>`).join('');
      return;
    }
    leg.style.flexWrap = '';
    if (o === 'power') {
      leg.innerHTML = `<i class="swatch" style="width:10px;height:10px;border-radius:3px;background:#f2c94c"></i>Powered <i class="swatch" style="width:10px;height:10px;border-radius:3px;background:#e34948;margin-left:8px"></i>No power`;
      return;
    }
    leg.innerHTML = `<span>${def.low}</span><span class="ramp" style="background:linear-gradient(90deg, ${def.color}33, ${def.color})"></span><span>${def.high}</span>`;
  }

  // ---- dropdowns -------------------------------------------------------------------

  private toggleDropdown(btn: HTMLElement, make: () => HTMLElement): void {
    if (this.dropdownEl && this.dropdownBtn === btn) {
      this.closeDropdown();
      return;
    }
    this.closeDropdown();
    const d = make();
    d.classList.add('dropdown', 'panel');
    $(this.root, '#dropRoot').appendChild(d);
    const r = btn.getBoundingClientRect();
    const w = d.offsetWidth;
    d.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    d.style.top = `${r.bottom + 6}px`;
    btn.setAttribute('aria-expanded', 'true');
    this.dropdownEl = d;
    this.dropdownBtn = btn;
  }

  closeDropdownIfOpen(): boolean {
    if (!this.dropdownEl) return false;
    this.closeDropdown();
    return true;
  }

  private closeDropdown(): void {
    this.dropdownEl?.remove();
    this.dropdownBtn?.setAttribute('aria-expanded', 'false');
    this.dropdownEl = null;
    this.dropdownBtn = null;
  }

  private layersMenu(): HTMLElement {
    const d = el('<div role="menu"></div>');
    for (const o of OVERLAYS) {
      const b = el<HTMLButtonElement>(`<button role="menuitemradio" aria-pressed="${this.game.renderer.overlay === o.id}"><span class="swatch" style="background:${o.color || 'transparent'};${o.color ? '' : 'border:1px solid var(--line-2)'}"></span>${o.name}</button>`);
      b.onclick = () => {
        this.setOverlay(o.id);
        this.closeDropdown();
      };
      d.appendChild(b);
    }
    return d;
  }

  private disasterMenu(): HTMLElement {
    const d = el('<div role="menu"></div>');
    const city = this.game.world.city;
    const tog = el<HTMLButtonElement>(`<button role="menuitemcheckbox" aria-pressed="${city.disasters}"><span class="swatch" style="background:${city.disasters ? 'var(--caution)' : 'transparent'};border:1px solid var(--line-2)"></span>Random disasters ${city.disasters ? 'on' : 'off'}</button>`);
    tog.onclick = () => {
      city.disasters = !city.disasters;
      this.toast(city.disasters ? 'Random disasters are on.' : 'Random disasters are off.');
      this.closeDropdown();
    };
    d.appendChild(tog);
    d.appendChild(el('<hr>'));
    d.appendChild(el('<div style="padding:4px 10px;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)">Unleash now</div>'));
    for (const k of Object.keys(DISASTER_NAMES) as DisasterKind[]) {
      const b = el<HTMLButtonElement>(`<button><span class="caution" style="width:10px;height:10px"></span>${DISASTER_NAMES[k]}</button>`);
      b.onclick = () => {
        this.game.sim?.disasters.trigger(k);
        this.closeDropdown();
      };
      d.appendChild(b);
    }
    return d;
  }

  private mainMenu(): HTMLElement {
    const d = el('<div role="menu"></div>');
    const add = (icon: string, label: string, fn: () => void) => {
      const b = el<HTMLButtonElement>(`<button role="menuitem">${ICONS[icon]}<span>${label}</span></button>`);
      b.querySelector('svg')?.setAttribute('style', 'width:18px;height:18px;flex:none;color:var(--muted)');
      b.onclick = () => {
        this.closeDropdown();
        fn();
      };
      d.appendChild(b);
    };
    add('file', this.game.mode === 'city' ? 'Save, open and share' : 'Save, open and share terrain', () => this.openFiles());
    add('book', 'Strategy guide', () => this.openGuide());
    add('settings', 'Settings and keys', () => this.openSettings());
    if (this.game.mode === 'city') add('guide', 'Show the starter checklist', () => {
      this.guideDismissed = false;
      this.updateGuide(true);
    });
    d.appendChild(el('<hr>'));
    add('home', 'Back to the title screen', () => this.confirmQuit());
    return d;
  }

  // ---- ticker, log, messages --------------------------------------------------------

  onMessage(m: Message): void {
    this.lastMessage = m;
    this.renderTicker();
    if (m.kind === 'alert') {
      const t = $(this.root, '#ticker');
      t.classList.remove('flash');
      void t.offsetWidth;
      t.classList.add('flash');
    }
    if (!$(this.root, '#log').hidden) this.renderLog();
  }

  private renderTicker(): void {
    const t = $(this.root, '#ticker');
    const m = this.lastMessage ?? this.game.sim?.messages[this.game.sim.messages.length - 1] ?? null;
    t.innerHTML = `
      <div class="msg kind-${m?.kind ?? 'info'}"><span class="kind-dot" aria-hidden="true"></span>
        <span class="msg-text">${m ? esc(m.text) : 'News from city hall shows up here.'}</span>
        ${m ? `<span class="when">${dateLabel(m.month)}</span>` : ''}
      </div>
      ${m && m.x !== undefined ? '<button id="tkGo">Go there</button>' : ''}
      <button id="tkLog" aria-expanded="${!$(this.root, '#log').hidden}">${ICONS.log.replace('<svg', '<svg style="width:16px;height:16px;vertical-align:-3px;margin-right:4px"')}News</button>`;
    const go = t.querySelector<HTMLElement>('#tkGo');
    if (go && m) go.onclick = () => this.jumpTo(m.x!, m.y!);
    $(t, '#tkLog').onclick = () => {
      const log = $(this.root, '#log');
      log.hidden = !log.hidden;
      if (!log.hidden) this.renderLog();
      this.renderTicker();
    };
  }

  private renderLog(): void {
    const log = $(this.root, '#log');
    const msgs = [...(this.game.sim?.messages ?? [])].reverse();
    log.innerHTML = msgs.length ? '' : '<p class="note" style="padding:8px">No news yet.</p>';
    for (const m of msgs.slice(0, 40)) {
      const row = el<HTMLButtonElement>(`<button class="row kind-${m.kind}"><span class="kind-dot"></span><span class="msg-text">${esc(m.text)}</span><span class="when num">${dateLabel(m.month)}</span></button>`);
      if (m.x !== undefined) row.onclick = () => this.jumpTo(m.x!, m.y!);
      else row.style.cursor = 'default';
      log.appendChild(row);
    }
  }

  jumpTo(x: number, y: number): void {
    const r = this.game.renderer;
    r.cam.zoom = Math.max(r.cam.zoom, 22);
    r.centerOn(x + 0.5, y + 0.5);
  }

  // ---- inspect -----------------------------------------------------------------------

  inspect(x: number, y: number, refresh = false): void {
    const sim = this.game.sim;
    const card = $(this.root, '#inspect');
    if (!sim) {
      card.hidden = true;
      return;
    }
    const d = sim.describe(x, y);
    card.innerHTML = `<button class="iconbtn close" aria-label="Close">${ICONS.close}</button><h3>${esc(d.title)}</h3><dl>${d.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    $(card, '.close').onclick = () => this.hideInspect();
    card.hidden = false;
    this.inspectAt = { x, y };
    if (!refresh) this.game.renderer.hover = { x, y };
  }

  hideInspect(): void {
    $(this.root, '#inspect').hidden = true;
    this.inspectAt = null;
  }

  // ---- starter checklist ------------------------------------------------------------

  private updateGuide(force: boolean): void {
    const g = this.game;
    const box = $(this.root, '#guide');
    if (g.mode !== 'city' || this.guideDismissed || g.world.city.scenario) {
      box.hidden = true;
      return;
    }
    if (!force && box.hidden) return;
    const w = g.world;
    let plant = false, res = false, com = false, ind = false, powered = false, grown = false;
    for (const b of w.buildings.values()) {
      if (BUILDINGS[b.kind].capacity) plant = true;
      if (b.kind === 'res') res = true;
      if (b.kind === 'com') com = true;
      if (b.kind === 'ind') ind = true;
      if (isZone(b.kind) && b.powered) powered = true;
      if (isZone(b.kind) && b.level > 0) grown = true;
    }
    let roads = 0;
    for (let i = 0; i < w.n; i++) if (w.net[i] & 1) roads++;
    const items: [boolean, string][] = [
      [plant, 'Build a power plant (coal is cheapest).'],
      [res && com && ind, 'Zone residential, commercial and industrial lots.'],
      [roads >= 6, 'Lay roads so each zone touches one.'],
      [powered, 'Run power lines from the plant to the zones.'],
      [grown, 'Unpause and watch the first buildings go up.'],
    ];
    if (items.every(([ok]) => ok) && !force) {
      this.guideDismissed = true;
      try { localStorage.setItem('terraville.guide', 'done'); } catch { /* ignore */ }
      box.hidden = true;
      this.toast('The city is growing. Keep an eye on the RCI meter at the top.');
      return;
    }
    box.hidden = false;
    box.style.cssText = 'position:absolute;right:10px;top:calc(var(--top) + 74px);width:260px;padding:12px 14px;z-index:12';
    box.innerHTML = `<button class="iconbtn close" aria-label="Hide checklist" style="position:absolute;top:6px;right:6px;width:26px;height:26px">${ICONS.close}</button>
      <h3 style="margin:0 0 8px;font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Getting started</h3>
      <ol style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px;font-size:13px">
        ${items.map(([ok, text]) => `<li style="display:flex;gap:8px;align-items:flex-start;${ok ? 'color:var(--muted)' : ''}">
          <span style="flex:none;width:18px;height:18px;border-radius:5px;display:grid;place-items:center;border:1px solid ${ok ? 'var(--good)' : 'var(--line-2)'};background:${ok ? 'var(--good)' : 'transparent'};color:#fff">${ok ? ICONS.check.replace('<svg', '<svg style="width:13px;height:13px"') : ''}</span>
          <span style="${ok ? 'text-decoration:line-through' : ''}">${text}</span></li>`).join('')}
      </ol>
      <button class="btn small" id="guideOpen" style="margin-top:10px;width:100%">Read the strategy guide</button>`;
    $(box, '#guideOpen').onclick = () => this.openGuide();
    $(box, '.close').onclick = () => {
      this.guideDismissed = true;
      try { localStorage.setItem('terraville.guide', 'done'); } catch { /* ignore */ }
      box.hidden = true;
    };
  }

  // ---- small feedback ------------------------------------------------------------

  cursorTip(sx: number, sy: number, html: string | null, bad = false): void {
    const tip = $(this.root, '#cursorTip');
    if (!html) {
      tip.hidden = true;
      return;
    }
    if (tip.innerHTML !== html) tip.innerHTML = html;
    tip.classList.toggle('bad', bad);
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const x = Math.min(window.innerWidth - w - 8, sx + 18);
    const y = Math.min(window.innerHeight - h - 8, sy + 20);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  /** A lasting notice for an unexpected error, with the message to report. */
  showError(e: unknown): void {
    if (this.root.querySelector('#errorBar')) return;
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const bar = el(`<div id="errorBar" class="panel" role="alert" style="position:absolute;left:50%;top:calc(var(--top) + 130px);transform:translateX(-50%);z-index:95;max-width:min(560px,calc(100vw - 32px));padding:12px 14px;display:flex;gap:12px;align-items:flex-start;border-color:var(--critical)">
      <span class="caution" style="background:var(--critical);margin-top:3px"></span>
      <div style="flex:1;min-width:0"><b>Something broke while drawing the map.</b>
      <div class="note">If it keeps happening, tell whoever sent you this game what it says here:</div>
      <code style="display:block;margin-top:6px;font:12px var(--mono);color:var(--critical-ink);word-break:break-word;user-select:text;-webkit-user-select:text">${esc(msg)}</code></div>
      <button class="iconbtn" aria-label="Dismiss">${ICONS.close}</button></div>`);
    $(bar, 'button').onclick = () => bar.remove();
    this.root.appendChild(bar);
  }

  toast(text: string, _kind: 'info' | 'warn' = 'info'): void {
    const t = $(this.root, '#toast');
    t.textContent = text;
    t.classList.remove('hide');
    this.toastTimer = 2.8;
  }

  // ---- modals -------------------------------------------------------------------------

  private openModal(spec: ModalSpec): HTMLElement {
    this.closeModal();
    this.closeDropdown();
    const root = $(this.root, '#modalRoot');
    const width = spec.width ?? (spec.wide ? 860 : 0);
    const m = el(`<div class="modal" role="dialog" aria-modal="true" ${width ? `style="width:min(${width}px,100%)"` : ''}>
      <header><div style="flex:1"><h2>${esc(spec.title)}</h2>${spec.sub ? `<div class="sub">${spec.sub}</div>` : ''}</div>
      <button class="iconbtn" data-close aria-label="Close">${ICONS.close}</button></header>
      <div class="body"></div></div>`);
    $(m, '.body').appendChild(spec.body);
    if (spec.foot?.length) {
      const f = el('<footer></footer>');
      for (const b of spec.foot) f.appendChild(b);
      m.appendChild(f);
    }
    $(m, '[data-close]').onclick = () => this.closeModal();
    root.innerHTML = '';
    root.appendChild(m);
    root.hidden = false;
    this.modalOpen = true;
    this.modalClose = spec.onClose ?? null;
    this.game.renderer.preview = null;
    this.cursorTip(0, 0, null);
    return m;
  }

  closeModal(): void {
    const root = $(this.root, '#modalRoot');
    if (root.hidden) return;
    root.hidden = true;
    root.innerHTML = '';
    this.modalOpen = false;
    const f = this.modalClose;
    this.modalClose = null;
    f?.();
  }

  /** Close whatever is on top (dropdown, dialog, log, inspect). Returns true if something closed. */
  closeTop(): boolean {
    if (this.dropdownEl) {
      this.closeDropdown();
      return true;
    }
    if (this.modalOpen) {
      this.closeModal();
      return true;
    }
    if (!$(this.root, '#log').hidden) {
      $(this.root, '#log').hidden = true;
      this.renderTicker();
      return true;
    }
    if (!$(this.root, '#inspect').hidden) {
      this.hideInspect();
      return true;
    }
    return false;
  }

  private btn(label: string, cls = '', onclick?: () => void): HTMLButtonElement {
    const b = el<HTMLButtonElement>(`<button class="btn ${cls}">${label}</button>`);
    if (onclick) b.onclick = onclick;
    return b;
  }

  // Founding ------------------------------------------------------------------------------

  openFound(fromQuick: boolean): void {
    let diff: Difficulty['id'] = 'easy';
    const body = el(`<div style="display:flex;flex-direction:column;gap:16px">
      <label class="field"><span>City name</span>
        <div class="seedrow"><input class="textin" id="fName" maxlength="28" value="${esc(randomCityName())}" spellcheck="false">
        <button class="iconbtn" id="fDice" aria-label="Another name" title="Another name">${ICONS.dice}</button></div></label>
      <div class="field"><span>Difficulty</span>
        <div class="choice" id="fDiff">${DIFFICULTIES.map((d) => `<button data-d="${d.id}" aria-pressed="${d.id === diff}"><b>${d.name}</b><span>${money(d.funds)} to start</span></button>`).join('')}</div>
      </div>
      <label class="switch"><span>Random disasters<small>Fires, floods, tornadoes and worse. You can also trigger them yourself.</small></span><input type="checkbox" id="fDis" checked></label>
      ${fromQuick ? '<p class="note">This land was generated at random. Shape it first in the terrain editor, or found the city as it is.</p>' : ''}
    </div>`);
    $(body, '#fDice').onclick = () => ($<HTMLInputElement>(body, '#fName').value = randomCityName());
    $(body, '#fDiff').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-d]');
      if (!b) return;
      diff = b.dataset.d as Difficulty['id'];
      for (const x of body.querySelectorAll('[data-d]')) x.setAttribute('aria-pressed', String(x === b));
    };
    const found = this.btn('Found the city', 'primary', () => {
      const name = $<HTMLInputElement>(body, '#fName').value;
      const dis = $<HTMLInputElement>(body, '#fDis').checked;
      this.closeModal();
      this.game.foundCity(name, diff, dis);
    });
    const other = fromQuick
      ? this.btn('Shape the land first', '', () => {
          this.closeModal();
          this.game.editCurrentLand();
        })
      : this.btn('Keep editing', '', () => this.closeModal());
    const reroll = fromQuick ? this.btn('Different land', '', () => {
      this.closeModal();
      this.game.quickStart();
    }) : null;
    this.openModal({
      title: 'Found a new city',
      sub: `On ${esc(STYLE_NAMES[this.game.terrain.style].toLowerCase())} land, seed <span class="num">${esc(this.game.terrain.seed)}</span>`,
      body,
      foot: [...(reroll ? [reroll] : []), other, found],
    });
    window.setTimeout(() => $<HTMLInputElement>(body, '#fName').select(), 30);
  }

  private confirmQuit(): void {
    const body = el(`<p class="note" style="font-size:14px">${this.game.mode === 'city' ? 'The city is autosaved each year and can be continued from the title screen. Save it to a slot first if you want to keep this exact moment.' : 'Unsaved terrain will be lost.'}</p>`);
    this.openModal({
      title: 'Leave for the title screen?',
      body,
      foot: [
        this.btn('Stay', '', () => this.closeModal()),
        this.btn('Leave', 'primary', async () => {
          this.closeModal();
          if (this.game.mode === 'city' && this.game.settings.autosave && !(await this.game.autosave())) {
            this.toast('The autosave failed, probably because storage is full. Save a city code from the menu if you want to keep this city.', 'warn');
            return;
          }
          this.game.showTitle();
        }),
      ],
    });
  }

  // Strategy guide -----------------------------------------------------------------------

  openGuide(): void {
    const body = buildGuide();
    const m = this.openModal({
      title: 'Strategy guide',
      sub: 'How Terraville cities work, and how to grow one. The clock stops while this is open.',
      body,
      width: 960,
    });
    const scroller = $(m, '.body');
    scroller.classList.add('guide-scroll');
    trackGuide(body, scroller);
  }

  // Challenges ---------------------------------------------------------------------------

  openChallenges(): void {
    const body = el(`<div class="slots"></div>`);
    for (const s of SCENARIOS) {
      const row = el(`<div class="slot" style="grid-template-columns:1fr auto">
        <div><b style="font-size:15px">${esc(s.name)}</b> <span class="note num">${s.year} · ${s.years} years</span>
        <p class="note" style="margin:4px 0 0">${esc(s.blurb)}</p>
        <p style="margin:6px 0 0;font-size:13px;display:flex;gap:8px;align-items:flex-start"><span class="caution" style="width:10px;height:10px;margin-top:4px"></span>${esc(s.goal)}</p></div>
        <div class="actions" style="grid-row:auto"></div></div>`);
      $(row, '.actions').appendChild(this.btn('Play', 'primary small', () => {
        this.closeModal();
        this.game.audio.play('click');
        this.game.startScenario(s.id);
      }));
      body.appendChild(row);
    }
    this.openModal({ title: 'Challenges', sub: 'Each one hands you a city with a problem and a deadline.', body });
  }

  scenarioIntro(s: Scenario): void {
    const body = el(`<div style="display:flex;flex-direction:column;gap:12px">
      <p style="margin:0;font-size:15px;line-height:1.55">${esc(s.blurb)}</p>
      <div class="panel" style="padding:12px 14px;display:flex;gap:10px;align-items:flex-start;box-shadow:none">
        <span class="caution" style="margin-top:3px"></span>
        <div><b>${esc(s.goal)}</b><div class="note">You have until ${s.year + s.years}. The goal tracker sits at the top right.</div></div>
      </div>
    </div>`);
    this.openModal({ title: s.name, sub: `<span class="num">${s.year}</span>`, body, foot: [this.btn('Begin', 'primary', () => this.closeModal())] });
  }

  updateGoal(s: Scenario, st: GoalState, monthsLeft: number, done: '' | 'won' | 'lost'): void {
    const box = $(this.root, '#goal');
    if (this.game.mode !== 'city') return;
    box.hidden = false;
    box.style.cssText = 'position:absolute;right:10px;top:calc(var(--top) + 74px);width:270px;padding:11px 13px;z-index:12;display:flex;flex-direction:column;gap:6px';
    const left = Math.max(0, monthsLeft);
    const time = done === 'won' ? 'Won' : done === 'lost' ? 'Time ran out' : `${Math.floor(left / 12)}y ${left % 12}m left`;
    const col = done === 'lost' ? 'var(--critical)' : st.met ? 'var(--good)' : 'var(--caution)';
    box.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
        <b style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">${esc(s.name)}</b>
        <span class="num" style="font-size:12px;color:${done === 'lost' ? 'var(--critical-ink)' : 'var(--text)'}">${time}</span></div>
      <div style="font-size:13px">${esc(st.status)}</div>
      <div class="barrow" style="grid-template-columns:1fr"><div class="track" role="img" aria-label="Progress ${Math.round(st.progress * 100)}%"><i style="width:${Math.max(2, st.progress * 100)}%;background:${col}"></i></div></div>`;
  }

  scenarioResult(s: Scenario, st: GoalState, won: boolean): void {
    const body = el(`<div style="display:flex;flex-direction:column;gap:10px">
      <p style="margin:0;font-size:15px">${won ? `${esc(s.name)} is a success. The council is already naming a street after you.` : `The deadline for ${esc(s.name)} has passed without reaching the goal.`}</p>
      <p class="note num" style="margin:0">${esc(st.status)}</p>
      <p class="note" style="margin:0">You can keep playing this city as long as you like.</p>
    </div>`);
    this.openModal({
      title: won ? 'Challenge complete' : "Time's up",
      body,
      foot: [
        this.btn('Back to the title screen', '', () => {
          this.closeModal();
          this.game.showTitle();
        }),
        ...(won ? [] : [this.btn('Try again', '', () => {
          this.closeModal();
          this.game.startScenario(s.id);
        })]),
        this.btn('Keep playing', 'primary', () => this.closeModal()),
      ],
    });
  }

  // Budget ------------------------------------------------------------------------------

  openBudget(): void {
    const g = this.game;
    const sim = g.sim;
    if (!sim) return;
    const city = g.world.city;
    const body = el(`<div style="display:flex;flex-direction:column;gap:18px">
      <div class="cols">
        <div>
          <h3>Taxes</h3>
          <label class="field"><span>Tax rate <span class="num" id="bTaxV"></span></span>
            <input type="range" id="bTax" min="0" max="20" step="1" value="${city.tax}"></label>
          <p class="note" id="bTaxNote" style="margin-top:6px"></p>
        </div>
        <div>
          <h3>Funding</h3>
          ${(['police', 'fire', 'transport'] as const).map((k) => `
            <label class="field" style="margin-bottom:8px"><span>${k === 'transport' ? 'Roads and rail' : k === 'police' ? 'Police' : 'Fire'} <span class="num" id="bF${k}V"></span></span>
            <input type="range" id="bF${k}" min="0" max="100" step="5" value="${Math.round(city.funding[k] * 100)}"></label>`).join('')}
        </div>
      </div>
      <div><h3>Last month</h3><table class="ledger" id="bLedger"></table></div>
      <div class="cols" style="align-items:end">
        <div><h3>Loans</h3><p class="note" id="bLoan"></p></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap" id="bLoanBtns"></div>
      </div>
    </div>`);
    const render = () => {
      $(body, '#bTaxV').textContent = `${city.tax}%`;
      const proj = sim.projectTax(city.tax);
      $(body, '#bTaxNote').innerHTML = `At ${city.tax}%, taxes bring in about <span class="num">${money(proj)}</span> a month. ${city.tax > 12 ? 'High taxes slow growth and anger residents.' : city.tax < 5 ? 'Low taxes attract people but starve the treasury.' : 'Around 7% keeps most people content.'}`;
      for (const k of ['police', 'fire', 'transport'] as const) $(body, `#bF${k}V`).textContent = `${Math.round(city.funding[k] * 100)}%`;
      const b = sim.stats.lastBudget;
      const y = sim.stats.yearBudget;
      const rows: [string, number, number][] = [
        ['Taxes', b.taxIncome, y.taxIncome],
        ['Roads and rail', -b.transport, -y.transport],
        ['Police', -b.police, -y.police],
        ['Fire', -b.fire, -y.fire],
        ['Parks, schools, ports', -b.services, -y.services],
        ['Power plants', -b.power, -y.power],
        ['Loan interest', -b.interest, -y.interest],
      ];
      const tot = rows.reduce((a, r) => a + r[1], 0);
      const totY = rows.reduce((a, r) => a + r[2], 0);
      const cell = (v: number) => `<td class="num ${v > 0.5 ? 'pos' : v < -0.5 ? 'neg' : ''}">${v > 0.5 ? '+' : ''}${money(v)}</td>`;
      $(body, '#bLedger').innerHTML = `<tr><th></th><th class="num">Month</th><th class="num">Year so far</th></tr>` +
        rows.map(([k, v, vy]) => `<tr><td>${k}</td>${cell(v)}${cell(vy)}</tr>`).join('') +
        `<tr class="total"><td>Net</td>${cell(tot)}${cell(totY)}</tr>`;
      $(body, '#bLoan').innerHTML = city.loan > 0
        ? `The city owes <span class="num">${money(city.loan)}</span> at 7% a year, about <span class="num">${money(city.loan * 0.07 / 12)}</span> in interest each month.`
        : 'No debt. You can borrow up to $30,000 at 7% a year.';
      const btns = $(body, '#bLoanBtns');
      btns.innerHTML = '';
      const borrow = this.btn('Borrow $10,000', 'small', () => {
        if (sim.takeLoan(10000)) {
          g.audio.play('coin');
          render();
          this.updateStats();
        }
      });
      borrow.disabled = city.loan + 10000 > 30000;
      const repay = this.btn('Repay $10,000', 'small', () => {
        if (sim.repayLoan(10000)) {
          render();
          this.updateStats();
        } else this.toast('Not enough money to repay that.');
      });
      repay.disabled = city.loan <= 0;
      btns.append(borrow, repay);
    };
    const tax = $<HTMLInputElement>(body, '#bTax');
    tax.oninput = () => {
      city.tax = Number(tax.value);
      render();
    };
    for (const k of ['police', 'fire', 'transport'] as const) {
      const s = $<HTMLInputElement>(body, `#bF${k}`);
      s.oninput = () => {
        city.funding[k] = Number(s.value) / 100;
        render();
      };
    }
    render();
    this.openModal({ title: 'Budget', sub: `${dateLabel(city.month)} · the clock stops while this is open`, body, foot: [this.btn('Done', 'primary', () => this.closeModal())] });
  }

  // History charts -------------------------------------------------------------------------

  openCharts(): void {
    const g = this.game;
    const h = g.world.city.history;
    const body = el(`<div style="display:flex;flex-direction:column;gap:12px">
      <div class="seg" id="cRange" style="max-width:320px">${[[120, '10 years'], [600, '50 years'], [1200, '100 years']].map(([n, l]) => `<button data-n="${n}" aria-pressed="${n === this.chartRange}">${l}</button>`).join('')}</div>
      <div class="chartgrid">
        <div class="chart" id="ch1"><h4>Residents and jobs</h4><div class="legendrow"><span><i style="background:${ZONE_COLORS.res}"></i>Residents</span><span><i style="background:${ZONE_COLORS.com}"></i>Commercial jobs</span><span><i style="background:${ZONE_COLORS.ind}"></i>Industrial jobs</span></div><canvas></canvas><div class="charttip" hidden></div></div>
        <div class="chart" id="ch2"><h4>City funds</h4><div class="legendrow"><span>End of each month</span></div><canvas></canvas><div class="charttip" hidden></div></div>
        <div class="chart" id="ch3"><h4>Monthly income and spending</h4><div class="legendrow"><span><i style="background:#3987e5"></i>Tax income</span><span><i style="background:#d95926"></i>Spending</span></div><canvas></canvas><div class="charttip" hidden></div></div>
        <div class="chart" id="ch4"><h4>Crime and pollution</h4><div class="legendrow"><span><i style="background:#d55181"></i>Crime</span><span><i style="background:#c98500"></i>Pollution</span><span>index, 0 to 100</span></div><canvas></canvas><div class="charttip" hidden></div></div>
      </div>
    </div>`);
    const draw = () => {
      const n = this.chartRange;
      const cut = <T,>(a: T[]) => a.slice(-n);
      const total = h.pop.length;
      const start = g.world.city.month - Math.min(n, total);
      const people = (v: number) => (Math.abs(v) >= 10000 ? `${Math.round(v / 1000)}k` : Math.round(v).toLocaleString());
      lineChart($(body, '#ch1'), [
        { name: 'Residents', color: ZONE_COLORS.res, values: cut(h.res) },
        { name: 'Commerce', color: ZONE_COLORS.com, values: cut(h.com) },
        { name: 'Industry', color: ZONE_COLORS.ind, values: cut(h.ind) },
      ], { startMonth: start, format: people, zero: true });
      lineChart($(body, '#ch2'), [{ name: 'Funds', color: '#3987e5', values: cut(h.funds) }], { startMonth: start, format: (v) => (Math.abs(v) >= 10000 ? `$${Math.round(v / 1000)}k` : money(v)) });
      lineChart($(body, '#ch3'), [
        { name: 'Income', color: '#3987e5', values: cut(h.income) },
        { name: 'Spending', color: '#d95926', values: cut(h.expense) },
      ], { startMonth: start, format: (v) => money(v), zero: true });
      lineChart($(body, '#ch4'), [
        { name: 'Crime', color: '#d55181', values: cut(h.crime).map((v) => Math.round((v / 255) * 100)) },
        { name: 'Pollution', color: '#c98500', values: cut(h.pollution).map((v) => Math.round((v / 255) * 100)) },
      ], { startMonth: start, format: (v) => String(Math.round(v)), zero: true });
    };
    $(body, '#cRange').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-n]');
      if (!b) return;
      this.chartRange = Number(b.dataset.n);
      for (const x of body.querySelectorAll('[data-n]')) x.setAttribute('aria-pressed', String(x === b));
      draw();
    };
    this.openModal({ title: 'History', sub: `${g.world.city.name} since ${dateLabel(Math.max(0, g.world.city.month - h.pop.length))}`, body, wide: true });
    requestAnimationFrame(draw);
  }

  // Report ---------------------------------------------------------------------------------

  openReport(): void {
    const g = this.game;
    const sim = g.sim;
    if (!sim) return;
    const s = sim.stats;
    const sev = (v: number) => (v > 60 ? 'var(--critical)' : v > 35 ? 'var(--serious)' : v > 15 ? 'var(--warn)' : 'var(--good)');
    const word = (v: number) => (v > 60 ? 'Severe' : v > 35 ? 'Serious' : v > 15 ? 'Minor' : 'Fine');
    const approval = Math.round(s.approval);
    const body = el(`<div style="display:flex;flex-direction:column;gap:18px">
      <div class="cols">
        <div>
          <h3>Mayor's approval</h3>
          <div style="display:flex;align-items:baseline;gap:10px"><span class="big">${approval}%</span><span class="note">${approval >= 70 ? 'People like how things are going.' : approval >= 45 ? 'Opinion is split.' : 'Residents are unhappy.'}</span></div>
          <div class="barrow" style="grid-template-columns:1fr;margin-top:10px"><div class="track"><i style="width:${approval}%;background:${approval >= 60 ? 'var(--good)' : approval >= 40 ? 'var(--warn)' : 'var(--critical)'}"></i></div></div>
        </div>
        <div>
          <h3>City</h3>
          <dl class="kv">
            <dt>Residents</dt><dd>${s.residents.toLocaleString()}</dd>
            <dt>Class</dt><dd>${cityClass(s.residents)}</dd>
            <dt>Last month</dt><dd>${s.migration >= 0 ? '+' : ''}${s.migration.toLocaleString()}</dd>
            <dt>Score</dt><dd>${s.score} / 1000</dd>
          </dl>
        </div>
      </div>
      <div>
        <h3>What people worry about</h3>
        <div class="bars">${s.problems.map((p) => `<div class="barrow"><span>${p.label}</span><div class="track" role="img" aria-label="${p.label}: ${word(p.value)}"><i style="width:${Math.max(2, p.value)}%;background:${sev(p.value)}"></i></div><span class="v">${word(p.value)}</span></div>`).join('')}</div>
      </div>
      <div class="cols">
        <dl class="kv">
          <dt>Commercial jobs</dt><dd>${s.comJobs.toLocaleString()}</dd>
          <dt>Industrial jobs</dt><dd>${s.indJobs.toLocaleString()}</dd>
          <dt>Unemployment</dt><dd>${Math.round(s.unemployment * 100)}%</dd>
          <dt>Zones (R/C/I)</dt><dd>${s.zones.res} / ${s.zones.com} / ${s.zones.ind}</dd>
        </dl>
        <dl class="kv">
          <dt>Power</dt><dd>${s.powerDemand.toLocaleString()} of ${s.powerSupply.toLocaleString()} MW</dd>
          <dt>Unpowered zones</dt><dd>${s.unpowered}</dd>
          <dt>Average land value</dt><dd>${money(s.avgLandValue * 40)}/acre</dd>
          <dt>Fires burning</dt><dd>${s.fires}</dd>
        </dl>
      </div>
    </div>`);
    this.openModal({ title: `${g.world.city.name} report`, sub: dateLabel(g.world.city.month), body, foot: [this.btn('Close', 'primary', () => this.closeModal())] });
  }

  // Files -----------------------------------------------------------------------------------

  openFiles(): void {
    const g = this.game;
    const canStore = storageAvailable();
    const inGame = g.mode !== 'title';
    const body = el(`<div style="display:flex;flex-direction:column;gap:18px">
      ${canStore ? '' : '<p class="note">This browser is blocking storage, so saves cannot be kept here. City codes still work: copy one somewhere safe and paste it back later.</p>'}
      ${inGame && canStore ? `<div><h3>Save</h3><div style="display:flex;gap:8px;flex-wrap:wrap" id="fSaveBtns"></div></div>` : ''}
      ${canStore ? '<div><h3>Saved here</h3><div class="slots" id="fSlots"></div></div>' : ''}
      ${inGame ? `<div><h3>Share this ${g.mode === 'city' ? 'city' : 'terrain'}</h3>
        <p class="note" style="margin-bottom:8px">A city code holds the whole map. Paste it into Open a city code on any device.</p>
        <div style="display:flex;gap:8px;margin-bottom:8px"><button class="btn small" id="fMake">Create city code</button><button class="btn small" id="fCopy" disabled>Copy</button></div>
        <textarea class="code" id="fCode" readonly placeholder="The code appears here." aria-label="City code"></textarea></div>` : ''}
      <div><h3>Open a city code</h3>
        <textarea class="code" id="fPaste" placeholder="Paste a code that starts with TV1" aria-label="Paste a city code"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center">
          <button class="btn small primary" id="fOpen">Open code</button>
          <label class="btn small" style="position:relative;overflow:hidden">Open a text file<input type="file" id="fFile" accept=".txt,.tvc,text/plain" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>
          <span class="note" id="fErr" style="color:var(--critical-ink)"></span>
        </div>
      </div>
    </div>`);
    const renderSlots = () => {
      const box = body.querySelector('#fSlots');
      if (!box) return;
      const slots = listSlots();
      box.innerHTML = slots.length ? '' : '<p class="note">Nothing saved yet.</p>';
      for (const s of slots) {
        const row = el(`<div class="slot"><b>${esc(s.name)}${s.id === 'auto' ? ' <span class="note">(autosave)</span>' : ''}</b>
          <div class="actions"></div>
          <span class="meta num">${s.mode === 'city' ? `${dateLabel(s.date)} · pop ${s.pop.toLocaleString()}` : 'Terrain'} · saved ${new Date(s.savedAt).toLocaleDateString()}</span></div>`);
        const actions = $(row, '.actions');
        actions.append(
          this.btn('Open', 'small primary', async () => {
            const f = await loadSlot(s.id);
            if (!f) return this.toast('That save could not be read.', 'warn');
            try {
              World.deserialize(f.world);
            } catch (e) {
              return this.toast(`That save is damaged: ${(e as Error).message}`, 'warn');
            }
            this.closeModal();
            g.loadFile(f, s.id);
            this.toast(`Opened ${s.name}.`);
          }),
          this.btn('Delete', 'small danger', () => {
            deleteSlot(s.id);
            renderSlots();
          }),
        );
        box.appendChild(row);
      }
    };
    renderSlots();
    const saveBtns = body.querySelector('#fSaveBtns');
    if (saveBtns) {
      if (g.slotId && g.slotId !== 'auto') {
        saveBtns.appendChild(this.btn('Save', 'primary', async () => {
          const ok = await g.saveTo(g.slotId!);
          this.toast(ok ? 'Saved.' : 'Saving failed. Storage may be full.', ok ? 'info' : 'warn');
          renderSlots();
        }));
      }
      saveBtns.appendChild(this.btn(g.slotId && g.slotId !== 'auto' ? 'Save as a new slot' : 'Save to a new slot', g.slotId && g.slotId !== 'auto' ? '' : 'primary', async () => {
        const id = 's' + Date.now().toString(36);
        const ok = await g.saveTo(id);
        this.toast(ok ? 'Saved.' : 'Saving failed. Storage may be full.', ok ? 'info' : 'warn');
        renderSlots();
      }));
    }
    const make = body.querySelector<HTMLButtonElement>('#fMake');
    if (make) {
      make.onclick = async () => {
        const code = await encode(g.makeSaveFile());
        const ta = $<HTMLTextAreaElement>(body, '#fCode');
        ta.value = code;
        $<HTMLButtonElement>(body, '#fCopy').disabled = false;
        make.textContent = `Code ready · ${Math.round(code.length / 1024)} KB`;
      };
      $(body, '#fCopy').onclick = async () => {
        const ta = $<HTMLTextAreaElement>(body, '#fCode');
        try {
          await navigator.clipboard.writeText(ta.value);
          this.toast('Copied.');
        } catch {
          ta.focus();
          ta.select();
          this.toast('Select all and copy the code.');
        }
      };
    }
    const openCode = async (code: string) => {
      const err = $(body, '#fErr');
      err.textContent = '';
      try {
        const f: SaveFile = await decode(code);
        World.deserialize(f.world);
        this.closeModal();
        g.loadFile(f);
        this.toast(`Opened ${f.world.city.name}.`);
      } catch (e) {
        err.textContent = (e as Error).message || 'That code could not be opened.';
      }
    };
    $(body, '#fOpen').onclick = () => openCode($<HTMLTextAreaElement>(body, '#fPaste').value);
    $<HTMLInputElement>(body, '#fFile').onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) await openCode(await file.text());
    };
    this.openModal({ title: inGame ? 'Save, open and share' : 'Open a saved city', body, wide: false });
  }

  // Settings -----------------------------------------------------------------------------------

  openSettings(): void {
    const g = this.game;
    const s = g.settings;
    const sw = (id: keyof typeof s, label: string, hint: string) =>
      `<label class="switch"><span>${label}<small>${hint}</small></span><input type="checkbox" data-set="${id}" ${s[id] ? 'checked' : ''}></label>`;
    const body = el(`<div class="cols">
      <div>
        <h3>Settings</h3>
        ${sw('sound', 'Sound effects', 'Clicks, construction and sirens.')}
        ${sw('traffic', 'Traffic and vehicles', 'Cars on busy roads.')}
        ${sw('night', 'Day and night', 'Streetlights and lit windows after dark. Time stops when paused.')}
        ${sw('grid', 'Tile grid', 'Faint lines between tiles when zoomed in.')}
        ${sw('contours', 'Contour lines in the city', 'Always on in the terrain editor.')}
        ${sw('autosave', 'Autosave', 'Every 90 seconds and at the end of each year.')}
      </div>
      <div>
        <h3>Keys</h3>
        <div class="keys">
          <kbd>Space</kbd><span>Pause or resume</span>
          <kbd>, .</kbd><span>Slower, faster</span>
          <kbd>1 2 3</kbd><span>Residential, commercial, industrial</span>
          <kbd>R T P</kbd><span>Road, rail, power line</span>
          <kbd>B</kbd><span>Bulldoze</span>
          <kbd>Right-click</kbd><span>Bulldoze what is under the cursor</span>
          <kbd>Shift drag</kbd><span>Bulldoze an area, any tool</span>
          <kbd>Q</kbd><span>Inspect</span>
          <kbd>Arrows</kbd><span>Move the map</span>
          <kbd>+ −</kbd><span>Zoom</span>
          <kbd>[ ]</kbd><span>Brush size</span>
          <kbd>Ctrl Z</kbd><span>Undo</span>
          <kbd>Esc</kbd><span>Cancel or close</span>
        </div>
        <p class="note" style="margin-top:12px">Right-drag, middle-drag or Space-drag moves the map with any tool. On touch, pinch to zoom and use two fingers to move.</p>
      </div>
    </div>`);
    body.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const k = t.dataset.set as keyof typeof s | undefined;
      if (!k) return;
      s[k] = t.checked;
      g.saveSettings();
    });
    this.openModal({ title: 'Settings', body, foot: [this.btn('Done', 'primary', () => this.closeModal())] });
  }
}

export { SPEED_NAMES };

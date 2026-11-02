// Everything in the DOM: top bar, toolbox, panels, dialogs, title screen.
import {
  BUILDINGS, DIFFICULTIES, DISASTER_POP, Difficulty, Kind, MAP_SIZES, ROAD, SEP, ToolDef, UPGRADE_LV, article, cityClass, dateLabel,
  isZone, nextUpgrade,
} from '../defs';
import { DISASTER_NAMES, DisasterKind } from '../disasters';
import { Game, SPEED_NAMES, randomCityName } from '../game';
import { OVERLAYS, Overlay, SLOPE_CLASSES } from '../render/renderer';
import { ZONE_COLORS } from '../render/color';
import { drawBuilding } from '../render/sprites';
import { randomSeedName } from '../rng';
import { DRIVE_HOME, DriveCopy } from '../drive';
import { SaveFile, SlotMeta, decode, deleteSlot, encode, listSlots, loadSlot, storageAvailable } from '../save';
import { spending } from '../sim';
import type { Message } from '../sim';
import { STYLE_NAMES, TerrainStyle, hasSea } from '../terrain';
import { GoalState, SCENARIOS, Scenario, successLine } from '../scenarios';
import { World } from '../world';
import { focusFromKeyboard, hasKeyboardFocus, watchFocus } from '../focus';
import { lineChart } from './charts';
import { buildGuide, trackGuide } from './guide';
import { ICONS } from './icons';

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T => root.querySelector(sel) as T;

/** What Tab can reach inside a dialog. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

/** The line every junkdrawer.works project carries: on the title screen and in Settings, never over the map. */
const JD_FOOT = `<footer class="jd-foot">
  <a href="https://junkdrawer.works/">Part of junkdrawer.works</a>
  <span aria-hidden="true">·</span>
  <a href="https://terraville.junkdrawer.works/privacy.html">Privacy</a>
</footer>`;

const DRIVE_WAITING = 'Waiting for a connection to save to Google Drive. The city is saved on this device.';
/** Listing Drive found no connection: no fault, so said plainly. */
const UNREACHABLE = 'Google Drive could not be reached, so only the cities on this device are listed.';

/** Text made safe to put in HTML. Not-quite-text from a damaged save is shown as text rather than stopping the page. */
function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** What a difficulty changes beyond the starting money, from its tax and disaster factors. */
function difficultyNote(d: Difficulty): string {
  const parts = [
    d.income > 1 ? 'taxes bring in more' : d.income < 1 ? 'taxes bring in less' : '',
    d.disasters < 1 ? 'fewer disasters' : d.disasters > 1 ? 'more disasters' : '',
  ].filter(Boolean);
  const text = parts.length ? parts.join(SEP) : 'the standard game';
  return text[0].toUpperCase() + text.slice(1);
}

/** Whether a zone has a road along one of its sides (a corner touching diagonally doesn't count), as growth asks. */
function touchesRoad(w: World, b: { x: number; y: number; size: number }): boolean {
  const s = b.size;
  for (let d = 0; d < s; d++) {
    for (const [x, y] of [[b.x + d, b.y - 1], [b.x + d, b.y + s], [b.x - 1, b.y + d], [b.x + s, b.y + d]]) {
      if (w.inBounds(x, y) && w.net[y * w.w + x] & ROAD) return true;
    }
  }
  return false;
}

/** A phone or tablet with no mouse: key letters and mouse moves mean nothing there (the style sheet asks the same). */
function touchScreen(): boolean {
  return matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/** Where each of the report's worries can be seen. Unemployment has no layer. */
const WORRY_LAYERS: Record<string, Overlay | 'budget'> = {
  crime: 'crime', pollution: 'pollution', housing: 'landValue', traffic: 'traffic', power: 'power', fire: 'fire', taxes: 'budget',
};

/** How the map works by touch, in Settings. */
const TOUCH_HELP = `<h3 class="touch-h">Touch</h3>
  <dl class="kv touch-help">
    <dt>One finger</dt><dd>Use the tool (with Inspect, move the map)</dd>
    <dt>Two fingers</dt><dd>Pinch to zoom, drag to move the map</dd>
    <dt>Bulldoze</dt><dd>Pick the bulldozer and drag over what to clear</dd>
  </dl>`;

/** The second press that confirms a purchase or a deletion: a click with a mouse, a tap on a touch screen. */
function again(): string {
  return matchMedia('(pointer: fine)').matches ? 'Click again' : 'Tap again';
}

/** Give a button a fuller name for a screen reader than its visible word, which the name starts with. */
function named<T extends HTMLElement>(b: T, label: string): T {
  b.setAttribute('aria-label', label);
  return b;
}

/** How long ago a moment was, briefly. */
export function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return `on ${new Date(t).toLocaleDateString()}`;
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
    <div id="inspect" class="panel" role="region" aria-labelledby="inspectTitle" hidden></div>
    <div id="tooltip" class="panel" hidden></div>
    <div id="cursorTip" hidden></div>
    <div id="toast" class="panel hide" role="status" aria-live="polite"></div>
    <div id="announce" class="sr-only" aria-live="polite"></div>
    <div id="announceAlert" class="sr-only" aria-live="assertive"></div>
    <button id="pausedPill" class="panel" hidden title="Resume (Space)">${ICONS.pause}<b>Paused</b><span class="by-key">Space to resume</span><span class="by-touch">Tap to resume</span></button>
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
  /** Only its own buttons close it: no close button, Escape or tap outside. */
  locked?: boolean;
}

export class UI {
  modalOpen = false;
  /** The open dialog closes only from its own buttons. */
  private modalLocked = false;
  /** Set while the save dialog is open, to redraw it when Drive changes. */
  private filesRefresh: (() => void) | null = null;
  private statTimer = 0;
  private toastTimer = 0;
  /** The mouse is on the toast, so it waits. */
  private toastHover = false;
  /** Puts away a tool's tooltip shown by a touch. */
  private tipTimer = 0;
  /** The tool button whose tooltip is up. */
  private tipOwner: HTMLElement | null = null;
  private inspectAt: { x: number; y: number } | null = null;
  /** The layer the Inspect card showed (a station's reach, a plant's grid), and the one to put back when it closes. */
  private inspectLayer: { shown: Overlay; was: Overlay } | null = null;
  private modalClose: (() => void) | null = null;
  /** Where focus goes back to when the dialog closes: what opened it, if the keyboard had put focus there. */
  private modalOpener: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private dropdownBtn: HTMLElement | null = null;
  private lastMessage: Message | null = null;
  private regenTimer = 0;
  private guideDismissed = false;
  private guideTimer = 0;
  /** The menu asked for the checklist: it stays until its close button, even with every step done. */
  private guideForced = false;
  /** This city's checklist has shown a step not done yet, so finishing it now is news. */
  private guideSawIncomplete = false;
  /** On a phone, the checklist has been tapped open. */
  private guideOpen = false;
  private chartRange = 120;

  constructor(private game: Game, private root: HTMLElement) {
    this.buildMinimapControls();
    $(root, '#modalRoot').addEventListener('pointerdown', (e) => {
      if (e.target === e.currentTarget && !this.modalLocked) this.closeModal();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.dropdownEl) return;
      const t = e.target as Node;
      if (this.dropdownEl.contains(t) || this.dropdownBtn?.contains(t)) return;
      this.closeDropdown();
    });
    window.addEventListener('resize', () => {
      this.closeDropdown();
      this.fitInspect();
    });
    watchFocus();
    document.addEventListener('keydown', (e) => {
      if (!this.modalOpen) return;
      if (e.key === 'Tab') this.keepTabInside(e);
      // Elsewhere Escape is the game's (it ignores keys typed into a field), so here it only needs to close the dialog
      // from a slider, a switch or a text box in it.
      else if (e.key === 'Escape' && !this.modalLocked && (e.target as HTMLElement).matches?.('input, textarea, select') && $(this.root, '#modalRoot').contains(e.target as Node)) this.closeModal();
    });
    game.drive.onChange(() => {
      this.syncDrive();
      this.filesRefresh?.();
      if (game.mode === 'title') this.renderTitleDrive();
    });
    // The cards above the ticker sit on its height, which grows when a message takes two lines.
    if (typeof ResizeObserver !== 'undefined') {
      const ticker = $(root, '#ticker');
      new ResizeObserver(() => {
        if (ticker.offsetHeight) root.style.setProperty('--ticker-h', `${ticker.offsetHeight}px`);
      }).observe(ticker);
    }
    const toast = $(root, '#toast');
    toast.addEventListener('pointerenter', (e) => (this.toastHover = e.pointerType === 'mouse'));
    toast.addEventListener('pointerleave', () => (this.toastHover = false));
    toast.addEventListener('pointerdown', () => this.hideToast());
    $(root, '#pausedPill').onclick = () => {
      this.game.togglePause();
      this.game.audio.play('click');
    };
    try {
      this.guideDismissed = localStorage.getItem('terraville.guide') === 'done';
    } catch {
      /* ignore */
    }
  }

  // ---- mode switches ----------------------------------------------------------

  enterTitle(): void {
    this.root.dataset.mode = 'title';
    this.closeModal();
    this.closeDropdown();
    for (const id of ['#topbar', '#toolbox', '#editorPanel', '#minimapCard', '#ticker', '#log', '#inspect', '#guide', '#goal']) $(this.root, id).hidden = true;
    const t = $(this.root, '#title');
    t.hidden = false;
    const last = this.game.latestLocal();
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
          ${last ? `<button class="btn" data-act="continue"><span>Continue ${esc(last.name)}</span><small class="num">${dateLabel(last.date)} · pop ${last.pop.toLocaleString()}</small></button>` : ''}
          <button class="btn" data-act="open"><span>Open a saved city</span><small>Saves and city codes</small></button>
          <div id="titleDrive" class="title-drive"></div>
        </div>
        <div class="title-foot">A city builder in the spirit of the 1989 classic and its terrain editor. Best with a mouse; touch works too.</div>
        ${JD_FOOT}
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
        if (!(await this.game.continueLatest())) this.toast('That save could not be opened.', 'warn');
      } else if (act === 'continue-drive' && this.titleCopy) {
        const c = this.titleCopy;
        try {
          await this.game.openFromDrive(c);
          this.toast(`Opened ${c.name}, saved on ${c.label} ${ago(c.saved)}.`);
        } catch (e) {
          this.toast(`Could not open it from Google Drive: ${(e as Error).message}`, 'warn');
        }
      } else if (act === 'drive-signin') {
        this.connectDrive();
      } else if (act === 'open' || act === 'drive-setup') this.openFiles();
    };
    this.titleCopy = null;
    this.titleChecked = false;
    // Google's sign-in script loads only for someone who has connected Drive (the game does that as it starts) or
    // opens Save, open and share, as the privacy page says.
    this.renderTitleDrive();
  }

  private titleCopy: DriveCopy | null = null;
  private titleChecked = false;

  /**
   * The title screen's line about Google Drive. When another device saved a
   * city more recently than anything here, Continue offers that copy instead.
   */
  private renderTitleDrive(): void {
    const box = this.root.querySelector<HTMLElement>('#titleDrive');
    if (!box) return;
    const drive = this.game.drive;
    const st = drive.status();
    if (st === 'unavailable') {
      box.innerHTML = '';
    } else if (st === 'off') {
      box.innerHTML = `<button class="linkbtn" data-act="drive-setup">Keep cities in Google Drive to carry on from any device</button>`;
    } else if (st === 'signin') {
      box.innerHTML = `<button class="linkbtn" data-act="drive-signin">Sign in to Google Drive</button> <span>to pick up cities from your other devices</span>`;
    } else {
      box.innerHTML = this.titleChecked ? '' : '<span>Checking Google Drive…</span>';
      if (this.titleChecked) return;
      this.titleChecked = true;
      drive.list().then((copies) => {
        if (this.game.mode !== 'title') return;
        const here = this.game.latestLocal();
        const local = new Map(listSlots().filter((s) => s.city).map((s) => [s.city!, s.savedAt]));
        const best = copies.find((c) => !c.mine && c.saved > (local.get(c.city) ?? 0) + 2000);
        box.innerHTML = '';
        if (!best || (here && here.savedAt >= best.saved)) return;
        this.titleCopy = best;
        const btn = el(`<button class="btn" data-act="continue-drive"><span>Continue ${esc(best.name)}</span><small class="num">From ${esc(best.label)} · ${ago(best.saved)}</small></button>`);
        const old = this.root.querySelector('#title [data-act="continue"]');
        // The same city, older, is not worth a second button.
        if (old && here?.city === best.city) old.replaceWith(btn);
        else this.root.querySelector('#title [data-act="open"]')?.before(btn);
      }, () => {
        box.innerHTML = '';
      });
    }
  }

  private showChrome(): void {
    $(this.root, '#title').hidden = true;
    for (const id of ['#topbar', '#toolbox', '#minimapCard']) $(this.root, id).hidden = false;
  }

  enterEditor(): void {
    this.root.dataset.mode = 'editor';
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
    this.root.dataset.mode = 'city';
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
    this.guideForced = this.guideSawIncomplete = false;
    this.updateGuide(true);
  }

  // ---- top bar -------------------------------------------------------------------

  private buildTopbarCity(): void {
    const top = $(this.root, '#topbar');
    top.innerHTML = `
      <button class="sign" id="citySign"><b id="signName"></b><small id="signSub"><span id="signPop"></span>${SEP}<span id="signClass"></span></small></button>
      <div class="panel stat-strip">
        <div class="stat" id="stDateBox"><span class="label" id="stDateLabel">Date</span><span class="value" id="stDate"></span></div>
        <div class="stat" id="stFundsBox"><span class="label">Funds</span><span class="value" id="stFunds"></span><span class="delta" id="stDelta"></span></div>
        <div class="rci" id="rci" role="img" title="Demand for residential, commercial and industrial land">
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
        <button data-act="undo" id="btnUndo" title="Undo (Ctrl+Z)" aria-label="Undo">${ICONS.undo}</button>
        <button data-act="redo" id="btnRedo" class="hide-sm" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${ICONS.redo}</button>
        <button data-act="drive" id="driveBtn" hidden aria-label="Google Drive">${ICONS.cloud}<span class="label" id="driveLbl"></span></button>
        <span class="menu-sep" aria-hidden="true"></span>
        <button data-act="budget" title="Budget">${ICONS.budget}<span class="label">Budget</span></button>
        <button data-act="charts" title="History">${ICONS.charts}<span class="label">History</span></button>
        <button data-act="report" class="hide-sm" title="City report">${ICONS.report}<span class="label">Report</span></button>
        <button data-act="layers" title="Map layers" aria-haspopup="menu" aria-expanded="false">${ICONS.layers}<span class="label">Layers</span></button>
        <button data-act="disasters" title="Disasters" aria-haspopup="menu" aria-expanded="false">${ICONS.disaster}<span class="label">Disasters</span></button>
        <button data-act="menu" title="Menu" aria-haspopup="menu" aria-expanded="false" aria-label="Menu">${ICONS.menu}</button>
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
        case 'undo': return this.game.undo();
        case 'redo': return this.game.redo();
        case 'drive': {
          const d = this.game.drive;
          if (d.status() === 'signin') return this.connectDrive();
          if (d.status() === 'error' || d.status() === 'waiting') void d.flush();
          return this.openFiles();
        }
        case 'budget': return this.openBudget();
        case 'charts': return this.openCharts();
        case 'report': return this.openReport();
        case 'layers': return this.toggleDropdown(b, () => this.layersMenu());
        case 'disasters': return this.toggleDropdown(b, () => this.disasterMenu());
        case 'menu': return this.toggleDropdown(b, () => this.mainMenu());
      }
    };
    this.syncSpeed();
    this.syncUndo();
    this.syncDrive();
  }

  /** Upload what waited for Drive now, and say how it went. */
  private async retryDrive(): Promise<void> {
    const d = this.game.drive;
    await d.flush();
    const st = d.status();
    this.toast(st === 'ok' ? 'Saved to Google Drive.' : st === 'waiting' ? DRIVE_WAITING : st === 'error' ? `Saving to Google Drive failed: ${d.error}` : 'Saving to Google Drive…', st === 'error' ? 'warn' : 'info');
  }

  /** Connect or sign in to Google Drive, or say why it can't yet. */
  private connectDrive(): void {
    const d = this.game.drive;
    if (!d.connect()) this.toast(d.loadFailed ? 'Google sign-in could not load. Check the connection.' : 'Google sign-in is still loading. Try again in a moment.', d.loadFailed ? 'warn' : 'info');
  }

  /** The top-bar cloud: shown once Drive is connected, loud only when it needs a tap. */
  syncDrive(): void {
    const b = this.root.querySelector<HTMLElement>('#driveBtn');
    if (!b) return;
    const d = this.game.drive;
    const st = d.status();
    b.hidden = st === 'unavailable' || st === 'off';
    b.dataset.s = st;
    // Phones have no room for the cloud, so the menu button carries a dot instead.
    this.root.querySelector('#topbar [data-act="menu"]')?.classList.toggle('attn', st === 'signin' || st === 'error');
    const lbl = $(b, '#driveLbl');
    lbl.textContent = st === 'signin' ? 'Sign in' : st === 'error' ? 'Sync failed' : st === 'waiting' ? 'Waiting' : '';
    b.title =
      st === 'signin' ? 'Google signed Terraville out. Click to sign in again and keep saving to Drive.' :
      st === 'error' ? `Saving to Google Drive failed: ${d.error} Click to try again.` :
      st === 'waiting' ? DRIVE_WAITING :
      st === 'busy' ? 'Saving to Google Drive…' :
      d.lastUpload ? `Saved to Google Drive ${ago(d.lastUpload)}` : 'Connected to Google Drive';
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
        <button data-act="menu" title="Menu" aria-haspopup="menu" aria-expanded="false" aria-label="Menu">${ICONS.menu}</button>
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
    // Until a new city first runs, Normal is marked as the button to start it (the single arrow is Slow).
    this.root.querySelector('[data-speed="2"]')?.classList.toggle('start-here', this.game.neverRun && this.game.speed === 0);
    // A lit pause button reads as "playing" to anyone used to media players,
    // so say it in words where the date is.
    const paused = this.game.speed === 0;
    this.root.querySelector('#stDateBox')?.classList.toggle('paused', paused);
    const label = this.root.querySelector('#stDateLabel');
    if (label) label.textContent = paused ? 'Paused' : 'Date';
    this.syncPausedPill();
  }

  /** The map badge: only in a city, with no dialog or toast in its place. */
  private syncPausedPill(): void {
    const g = this.game;
    const show = g.mode === 'city' && g.speed === 0 && !this.modalOpen && this.toastTimer <= 0;
    const pill = $(this.root, '#pausedPill');
    if (pill.hidden === show) pill.hidden = !show;
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
    set('signPop', `Pop ${s.residents.toLocaleString()}`);
    set('signClass', cityClass(s.residents));
    set('stDate', dateLabel(city.month));
    set('stFunds', money(city.funds));
    const b = s.lastBudget;
    const net = b.taxIncome - spending(b);
    const d = this.root.querySelector('#stDelta');
    if (d) {
      d.textContent = city.month > 0 ? `${net >= 0 ? '+' : '−'}${money(Math.abs(net)).replace('−', '')}/mo` : '';
      d.className = 'delta ' + (net > 0.5 ? 'up' : net < -0.5 ? 'down' : '');
    }
    this.root.querySelector('#stFundsBox')?.classList.toggle('funds-low', city.funds < 0);
    const bar = (id: string, v: number) => {
      const e = this.root.querySelector<HTMLElement>('#' + id);
      // The zero line is the middle of the bar, which is shorter on a phone; full demand fills its half.
      const mid = (e?.parentElement?.clientHeight ?? 0) / 2;
      if (!e || !mid) return;
      const h = Math.max(1, Math.abs(v) * (mid - 1));
      e.style.height = `${h}px`;
      e.style.top = v >= 0 ? `${mid - h}px` : `${mid}px`;
    };
    bar('rciR', city.demand.r);
    bar('rciC', city.demand.c);
    bar('rciI', city.demand.i);
    // What the bars show, in words, rewritten only when the words change.
    const word = (v: number) => (v >= 0.45 ? 'high' : v >= 0.1 ? 'moderate' : v > -0.1 ? 'low' : 'negative');
    const rci = this.root.querySelector('#rci');
    const said = `Demand: homes ${word(city.demand.r)}, shops ${word(city.demand.c)}, industry ${word(city.demand.i)}`;
    if (rci && rci.getAttribute('aria-label') !== said) rci.setAttribute('aria-label', said);
    // The sign opens the report, and says what it shows.
    const sign = this.root.querySelector('#citySign');
    const name = `${city.name}, ${s.residents.toLocaleString()} residents, ${cityClass(s.residents).toLowerCase()}. City report`;
    if (sign && sign.getAttribute('aria-label') !== name) sign.setAttribute('aria-label', name);
  }

  tick(dt: number): void {
    this.statTimer -= dt;
    if (this.statTimer <= 0) {
      this.statTimer = 0.25;
      this.updateStats();
    }
    if (this.toastTimer > 0 && !this.toastHover) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.hideToast();
    }
    this.syncPausedPill();
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
    this.refreshInspect();
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
        const b = el<HTMLButtonElement>(`<button class="tool" data-tool="${t.id}" aria-label="${esc(t.name)}"${t.key ? ` aria-keyshortcuts="${t.key}"` : ''}></button>`);
        b.appendChild(this.toolIcon(t));
        if (t.key) b.appendChild(el(`<span class="key">${t.key.toUpperCase()}</span>`));
        b.addEventListener('click', () => {
          this.game.setTool(t.id);
          this.game.audio.play('click');
        });
        b.addEventListener('pointerenter', (e) => {
          this.showToolTip(b, t);
          // A finger leaves the button as it lifts: the tip stays a moment to be read, then goes.
          if (e.pointerType !== 'mouse') this.tipTimer = window.setTimeout(() => this.hideToolTip(), 2000);
        });
        b.addEventListener('pointerleave', (e) => {
          if (e.pointerType === 'mouse') this.hideToolTip(b);
        });
        // Only the keyboard's focus shows it: a tap focuses the button too, and nothing on the map takes focus away.
        b.addEventListener('focus', () => {
          if (focusFromKeyboard(b)) this.showToolTip(b, t);
        });
        // Focus leaves the last tool after the next one's tip is up.
        b.addEventListener('blur', () => this.hideToolTip(b));
        g.appendChild(b);
      }
      box.appendChild(g);
    }
    // The brushes' size (and in the editor, strength). In the city only Level land is a brush: it shows while that is
    // the tool, under the tools, or at the end of the phone's row beside it.
    const editor = this.game.mode === 'editor';
    const bb = el(`<div class="brushbox" id="brushBox">
      <label>Brush size <span class="num" id="brushTiles"></span><input type="range" id="brushSize" min="1" max="14" step="0.5"></label>
      ${editor ? '<label>Strength <input type="range" id="brushStrength" min="0.1" max="1.5" step="0.05"></label>' : ''}
    </div>`);
    const size = $<HTMLInputElement>(bb, '#brushSize');
    size.oninput = () => {
      this.game.brush.radius = Number(size.value);
      this.syncBrushSize();
    };
    if (editor) {
      const str = $<HTMLInputElement>(bb, '#brushStrength');
      str.value = String(this.game.brush.strength);
      str.oninput = () => (this.game.brush.strength = Number(str.value));
    }
    box.appendChild(bb);
    this.syncBrushSize();
    this.syncTool();
  }

  nudgeBrush(d: number): void {
    this.game.brush.radius = Math.max(1, Math.min(14, this.game.brush.radius + d));
    this.syncBrushSize();
  }

  /** Show the brush's size on its slider: tiles across, as its ring spans on the map. */
  private syncBrushSize(): void {
    const r = this.game.brush.radius;
    const s = this.root.querySelector<HTMLInputElement>('#brushSize');
    if (s) s.value = String(r);
    const t = this.root.querySelector<HTMLElement>('#brushTiles');
    if (t) t.textContent = `${Math.round(r * 2)} tiles`;
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

  /** Put away a tool's tooltip (only if it is `owner`'s): the pointer left, a touch's moment is up, or the map was touched. */
  hideToolTip(owner?: HTMLElement): void {
    if (owner && owner !== this.tipOwner) return;
    window.clearTimeout(this.tipTimer);
    $(this.root, '#tooltip').hidden = true;
    this.tipOwner?.removeAttribute('aria-describedby');
    this.tipOwner = null;
  }

  private showToolTip(b: HTMLElement, t: ToolDef): void {
    window.clearTimeout(this.tipTimer);
    // While its tip shows, the tool is described by it: cost, upkeep and what it does.
    if (this.tipOwner !== b) this.tipOwner?.removeAttribute('aria-describedby');
    b.setAttribute('aria-describedby', 'tooltip');
    this.tipOwner = b;
    const tip = $(this.root, '#tooltip');
    const cost = t.cost ? `<span class="cost">${t.kind === 'line' || t.id === 'bulldoze' || t.id === 'trees' || t.id === 'park' ? `$${t.cost} a tile` : money(t.cost)}${t.building && BUILDINGS[t.building].upkeep ? ` · ${money(BUILDINGS[t.building].upkeep)}/mo upkeep` : ''}</span>` : '';
    const touch = touchScreen();
    const zoneTip = t.building && isZone(t.building) ? `<p>${esc(BUILDINGS[t.building].blurb)} Drag to zone several 3×3 lots.</p>` : `<p>${esc((touch && t.touchTip) || t.tip)}</p>`;
    const keys = t.kind === 'brush' && !touch ? '<p><kbd>[</kbd> and <kbd>]</kbd> change the brush size.</p>' : '';
    tip.innerHTML = `<b>${esc(t.name)}${t.key && !touch ? ` <kbd>${t.key.toUpperCase()}</kbd>` : ''}</b>${cost}${zoneTip}${keys}`;
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
    const bb = this.root.querySelector<HTMLElement>('#brushBox');
    if (bb && this.game.mode === 'city') {
      const was = bb.hidden;
      bb.hidden = this.game.toolId !== 'level';
      // The toolbox scrolls in a short window, and the phone's row sideways: bring the slider into view by the tool.
      if (was && !bb.hidden) bb.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
    p.classList.toggle('collapsed', this.compact());
    p.innerHTML = `
      <h2 id="edHead" style="cursor:pointer">Generate land</h2>
      <div class="field"><span id="edStyleCap">Landscape</span>
        <div class="seg" id="edStyle" role="group" aria-labelledby="edStyleCap">${styles.map((s) => `<button data-style="${s}" aria-pressed="${s === t.style}">${STYLE_NAMES[s]}</button>`).join('')}</div>
      </div>
      <div class="field"><span id="edSizeCap">Map size</span>
        <div class="seg" id="edSize" role="group" aria-labelledby="edSizeCap">${MAP_SIZES.map((m) => `<button data-size="${m.id}" aria-pressed="${m.w === t.w}">${m.name}<br><span class="num" style="font-weight:500;font-size:10.5px">${m.w}×${m.h}</span></button>`).join('')}</div>
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
      if (this.compact()) p.classList.toggle('collapsed');
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
      const sw = (c: string, label: string, title: string) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px" title="${title}"><i style="width:10px;height:10px;border-radius:3px;display:inline-block;background:${c}"></i>${label}</span>`;
      leg.style.flexWrap = 'wrap';
      leg.innerHTML = sw('#f2c94c', 'Powered', 'Buildings and lines with power') +
        sw('#f08a3c', 'Grid overloaded', 'Connected, but this grid needs more power than its plants make') +
        sw('#e34948', 'Not connected', 'No power plant reaches this');
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
    d.style.maxHeight = `${Math.max(120, window.innerHeight - r.bottom - 14)}px`;
    btn.setAttribute('aria-expanded', 'true');
    this.dropdownEl = d;
    this.dropdownBtn = btn;
    d.addEventListener('keydown', (e) => this.menuKey(e));
    d.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  /** Arrow keys, Home and End move through an open menu; Tab leaves it. */
  private menuKey(e: KeyboardEvent): void {
    const items = [...(this.dropdownEl?.querySelectorAll<HTMLElement>('button') ?? [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const last = items.length - 1;
    let next: number;
    if (e.key === 'ArrowDown') next = at < 0 || at === last ? 0 : at + 1;
    else if (e.key === 'ArrowUp') next = at <= 0 ? last : at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else {
      // Tab goes on from the menu's button, as if the menu had never opened.
      if (e.key === 'Tab') this.closeDropdown();
      return;
    }
    e.preventDefault();
    e.stopPropagation(); // the arrow keys would also move the map
    items[next].focus();
  }

  closeDropdownIfOpen(): boolean {
    if (!this.dropdownEl) return false;
    this.closeDropdown();
    return true;
  }

  private closeDropdown(): void {
    // Focus goes back to the menu's button if the keyboard was in the menu.
    const back = this.dropdownEl?.contains(document.activeElement) && hasKeyboardFocus(document.activeElement) ? this.dropdownBtn : null;
    this.dropdownEl?.remove();
    this.dropdownBtn?.setAttribute('aria-expanded', 'false');
    this.dropdownEl = null;
    this.dropdownBtn = null;
    back?.focus({ preventScroll: true });
  }

  private layersMenu(): HTMLElement {
    const d = el('<div role="menu"></div>');
    for (const o of OVERLAYS) {
      const b = el<HTMLButtonElement>(`<button role="menuitemradio" aria-checked="${this.game.renderer.overlay === o.id}"><span class="swatch" style="background:${o.color || 'transparent'};${o.color ? '' : 'border:1px solid var(--line-2)'}"></span>${o.name}</button>`);
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
    const tog = el<HTMLButtonElement>(`<button role="menuitemcheckbox" aria-checked="${city.disasters}"><span class="swatch" style="background:${city.disasters ? 'var(--caution)' : 'transparent'};border:1px solid var(--line-2)"></span>Random disasters ${city.disasters ? 'on' : 'off'}</button>`);
    tog.onclick = () => {
      city.disasters = !city.disasters;
      this.toast(city.disasters ? 'Random disasters are on.' : 'Random disasters are off.');
      this.closeDropdown();
    };
    d.appendChild(tog);
    d.appendChild(el('<hr>'));
    // The heading is seen; a screen reader hears it once, as the group's name.
    d.appendChild(el('<div class="menu-caption" aria-hidden="true">Unleash now</div>'));
    const group = el('<div role="group" aria-label="Unleash now"></div>');
    for (const k of Object.keys(DISASTER_NAMES) as DisasterKind[]) {
      const b = el<HTMLButtonElement>(`<button role="menuitem"><span class="caution" style="width:10px;height:10px"></span>${DISASTER_NAMES[k]}</button>`);
      b.onclick = () => {
        this.game.sim?.disasters.trigger(k);
        this.closeDropdown();
      };
      group.appendChild(b);
    }
    d.appendChild(group);
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
    // A phone's editor hides the map layer card, which is where the steepness layer is picked.
    if (this.game.mode === 'editor' && this.narrow()) {
      const on = this.game.renderer.overlay === 'slope';
      add('contour', on ? 'Hide the steepness' : 'Show the steepness', () => this.setOverlay(on ? 'none' : 'slope'));
    }
    // A phone has no room for Redo in the top bar, and no keyboard for Ctrl+Shift+Z.
    if (this.game.mode === 'city' && this.compact() && this.game.canRedo()) add('redo', 'Redo', () => this.game.redo());
    const drive = this.game.drive;
    if (this.game.mode === 'city' && drive.status() === 'signin') {
      add('cloud', 'Sign in to Google Drive', () => this.connectDrive());
    }
    // A phone has no cloud in the top bar to tap, so the menu offers the retry.
    if (this.game.mode === 'city' && drive.status() === 'error') add('cloud', 'Saving to Drive failed: try again', () => void this.retryDrive());
    add('file', this.game.mode === 'city' ? 'Save, open and share' : 'Save, open and share terrain', () => this.openFiles());
    add('book', 'Strategy guide', () => this.openGuide());
    add('settings', touchScreen() ? 'Settings and touch' : 'Settings and keys', () => this.openSettings());
    if (this.game.mode === 'city') add('guide', 'Show the starter checklist', () => {
      this.guideDismissed = false;
      this.guideForced = true;
      this.updateGuide(true);
    });
    d.appendChild(el('<hr>'));
    add('home', 'Back to the title screen', () => this.confirmQuit());
    return d;
  }

  // ---- ticker, log, messages --------------------------------------------------------

  /** A short glow on the city's sign, for a new size class. */
  glowSign(): void {
    const sign = this.root.querySelector<HTMLElement>('#citySign');
    if (!sign) return;
    sign.classList.remove('glow');
    void sign.offsetWidth;
    sign.classList.add('glow');
  }

  onMessage(m: Message): void {
    this.lastMessage = m;
    this.renderTicker();
    this.announce(m);
    if (m.kind === 'alert') {
      const t = $(this.root, '#ticker');
      t.classList.remove('flash');
      void t.offsetWidth;
      t.classList.add('flash');
    }
    if (!$(this.root, '#log').hidden) this.renderLog();
  }

  /**
   * Say a piece of news to a screen reader, an alert at once: the ticker itself isn't a live region, so nothing is
   * read twice. News a toast also shows (a new size class, say) is left to the toast.
   */
  private announce(m: Message): void {
    window.setTimeout(() => {
      const toast = $(this.root, '#toast');
      if (!toast.classList.contains('hide') && toast.textContent === m.text) return;
      const r = $(this.root, m.kind === 'alert' ? '#announceAlert' : '#announce');
      r.textContent = m.text;
    }, 0);
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
    $(t, '#tkLog').onclick = () => this.toggleLog();
    // Two lines may not hold a message: a tap on it opens the log, where it is whole.
    $(t, '.msg').onclick = () => this.toggleLog();
  }

  private toggleLog(): void {
    const log = $(this.root, '#log');
    log.hidden = !log.hidden;
    if (!log.hidden) {
      this.renderLog();
      if (this.narrow() || this.overlaps(log, $(this.root, '#inspect'))) this.hideInspect();
    }
    this.renderTicker();
  }

  /** Whether two cards on screen cover each other: the log and the Inspect card do in a window about 1,000 px wide. */
  private overlaps(a: HTMLElement, b: HTMLElement): boolean {
    if (a.hidden || b.hidden) return false;
    const r = a.getBoundingClientRect();
    const q = b.getBoundingClientRect();
    return r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom;
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
      this.hideInspect();
      return;
    }
    const d = sim.describe(x, y);
    const b = this.game.world.buildingAt(x, y);
    const up = b && this.game.upgradeFor(b);
    // A second stadium, say, can't add anything: only the most upgraded one of each kind counts.
    const outdone = b && !up && nextUpgrade(b) && this.game.mode === 'city';
    // A station's reach, or a plant's grid, is a layer away.
    const layer: Overlay | undefined = !b ? undefined
      : b.kind === 'police' ? 'police' : b.kind === 'fire' ? 'fire' : b.kind === 'school' || b.kind === 'hospital' ? 'service'
        : BUILDINGS[b.kind].capacity ? 'power' : undefined;
    const showLayer = layer && this.game.renderer.overlay !== layer
      ? `<button class="btn small" id="inLayer" style="margin-top:10px">${layer === 'power' ? 'Show the power grid' : 'Show its reach'}</button>` : '';
    // Sentences read as text; figures stay in the card's mono.
    const prose = new Set(['Does', 'Land value it adds']);
    card.innerHTML = `<button class="iconbtn close" aria-label="Close">${ICONS.close}</button><h3 id="inspectTitle">${esc(d.title)}</h3><dl>${d.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd${prose.has(k) ? ' class="text"' : ''}>${esc(v)}</dd>`).join('')}</dl>${showLayer}${d.note ? `<p class="note why">${esc(d.note)}</p>` : ''}${up ? `
      <div class="upgrade"><p class="note">Upgrade to ${article(up.name)} <b>${esc(up.name.toLowerCase())}</b>: land value rises by <span class="num">${money(UPGRADE_LV * 40)}</span>/acre across the whole city, and upkeep by <span class="num">${money(up.upkeep)}</span>/mo.</p>
      <button class="btn small primary" id="inUpgrade">Upgrade for ${money(up.cost)}</button></div>` : outdone ? `
      <div class="upgrade"><p class="note">Only the city's most upgraded ${esc(BUILDINGS[b.kind].name.toLowerCase())} raises land value, so this one has no upgrade.</p></div>` : ''}`;
    $(card, '.close').onclick = () => this.hideInspect();
    const lb = card.querySelector<HTMLButtonElement>('#inLayer');
    if (lb && layer) {
      lb.onclick = () => {
        this.inspectLayer = { shown: layer, was: this.inspectLayer?.was ?? this.game.renderer.overlay };
        this.setOverlay(layer);
        this.inspect(x, y, true);
      };
    }
    const ub = card.querySelector<HTMLButtonElement>('#inUpgrade');
    if (ub && b && up) {
      ub.onclick = () => {
        // Undo or a disaster may have changed the landmark since the card was drawn: show it as it is now instead.
        if (this.game.upgradeFor(b) !== up) return this.inspect(x, y, true);
        // A big purchase: the second tap pays.
        if (!ub.dataset.sure) {
          ub.dataset.sure = '1';
          ub.textContent = `${again()} to pay ${money(up.cost)}`;
          return;
        }
        if (!this.game.upgrade(b)) return;
        this.inspect(x, y, true);
      };
    }
    card.hidden = false;
    // On a phone the card takes the bottom slot that the map layer card and the news log also use; in a window too
    // narrow for both side by side it takes the log's place too.
    this.root.classList.add('inspecting');
    const log = $(this.root, '#log');
    if (!refresh && !log.hidden && (this.narrow() || this.overlaps(card, log))) {
      log.hidden = true;
      this.renderTicker();
    }
    this.inspectAt = { x, y };
    if (!refresh) this.game.renderer.hover = { x, y };
    this.fitInspect();
  }

  /**
   * In a short phone-shaped window (a laptop window at 200% zoom is 640x400), the card would grow up over the folded
   * checklist or the goal and the top bar: there it stops below them and scrolls.
   */
  private fitInspect(): void {
    const card = $(this.root, '#inspect');
    card.style.maxHeight = card.style.overflowY = '';
    if (card.hidden || !this.narrow() || window.innerHeight > 560) return;
    let top = $(this.root, '#topbar').getBoundingClientRect().bottom;
    for (const id of ['#guide', '#goal']) {
      const c = $(this.root, id);
      if (!c.hidden) top = Math.max(top, c.getBoundingClientRect().bottom);
    }
    card.style.maxHeight = `${Math.max(80, card.getBoundingClientRect().bottom - top - 8)}px`;
    card.style.overflowY = 'auto';
  }

  /** Draw the open Inspect card again for what is on its tile now, after undo or redo say. */
  refreshInspect(): void {
    if (this.inspectAt) this.inspect(this.inspectAt.x, this.inspectAt.y, true);
  }

  hideInspect(): void {
    $(this.root, '#inspect').hidden = true;
    this.root.classList.remove('inspecting');
    this.inspectAt = null;
    // The layer the card put up goes back to the one before, unless someone has picked another since.
    const l = this.inspectLayer;
    this.inspectLayer = null;
    if (l && this.game.renderer.overlay === l.shown) this.setOverlay(l.was);
  }

  /** Whether the starter checklist is on screen. */
  checklistShown(): boolean {
    return !$(this.root, '#guide').hidden;
  }

  /** A phone-sized window, where the panels stack in one column (the style sheet's breakpoint). */
  private narrow(): boolean {
    return window.innerWidth <= 820;
  }

  /** A phone either way up: narrow, or short (held sideways), where the checklist and editor panel fold away. */
  private compact(): boolean {
    return this.narrow() || window.innerHeight <= 500;
  }

  // ---- starter checklist ------------------------------------------------------------

  /** Redraw the checklist; `force` looks at it even while it is hidden, as when a city opens or the menu asks. */
  private updateGuide(force: boolean): void {
    const g = this.game;
    const box = $(this.root, '#guide');
    if (g.mode !== 'city' || this.guideDismissed || g.world.city.scenario) {
      box.hidden = true;
      return;
    }
    if (!force && box.hidden) return;
    const w = g.world;
    let plant = false, res = false, com = false, ind = false, grown = false;
    let zones = 0, roaded = 0, powered = 0;
    for (const b of w.buildings.values()) {
      if (BUILDINGS[b.kind].capacity) plant = true;
      if (b.kind === 'res') res = true;
      if (b.kind === 'com') com = true;
      if (b.kind === 'ind') ind = true;
      if (!isZone(b.kind)) continue;
      zones++;
      // Worked out here rather than taken from the simulation, which looks only as the clock runs.
      if (touchesRoad(w, b)) roaded++;
      if (b.powered) powered++;
      if (b.level > 0) grown = true;
    }
    const count = (n: number, what: string) => (zones && n < zones ? `${n} of ${zones} zones ${what}` : '');
    const items: [boolean, string, string][] = [
      [plant, 'Build a power plant (coal powers a whole town).', ''],
      [res && com && ind, 'Zone residential, commercial and industrial lots.', ''],
      [zones > 0 && roaded === zones, 'Lay roads so each zone touches one.', count(roaded, roaded === 1 ? 'touches a road' : 'touch a road')],
      [zones > 0 && powered === zones, 'Run power lines from the plant to the zones.', count(powered, powered === 1 ? 'has power' : 'have power')],
      [grown, 'Press play and watch the first buildings go up.', ''],
    ];
    // Finished: it goes, with a word only if this visit saw it unfinished (a city opened grown says nothing), unless
    // the menu asked for it, when only its close button hides it.
    const complete = items.every(([ok]) => ok);
    if (!complete) this.guideSawIncomplete = true;
    else if (!this.guideForced) {
      this.guideDismissed = true;
      try { localStorage.setItem('terraville.guide', 'done'); } catch { /* ignore */ }
      box.hidden = true;
      if (this.guideSawIncomplete) this.toast('The city is growing. Keep an eye on the RCI meter at the top.');
      return;
    }
    box.hidden = false;
    const done = items.filter(([ok]) => ok).length;
    // On a phone the list would cover a third of the map: it is one line, 'Next: …', until tapped open.
    const small = this.compact();
    const folded = small && !this.guideOpen;
    const next = items.find(([ok]) => !ok);
    const html = folded
      ? `<button class="guide-next" aria-expanded="false"><span class="guide-next-text">${next ? `<b>Next:</b> ${next[1]}` : '<b>All done.</b> Keep an eye on the RCI meter.'}</span><span class="num">${done} of ${items.length} done</span><i class="chev" aria-hidden="true"></i></button>`
      : `<button class="iconbtn close" aria-label="Hide checklist" style="position:absolute;top:6px;right:6px;width:26px;height:26px">${ICONS.close}</button>
      ${small
        ? '<button class="guide-head" aria-expanded="true">Getting started <i class="chev up" aria-hidden="true"></i></button>'
        : '<h3 class="guide-head">Getting started</h3>'}
      <ol style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px;font-size:13px">
        ${items.map(([ok, text, more]) => `<li style="display:flex;gap:8px;align-items:flex-start;${ok ? 'color:var(--muted)' : ''}">
          <span style="flex:none;width:18px;height:18px;border-radius:5px;display:grid;place-items:center;border:1px solid ${ok ? 'var(--good)' : 'var(--line-2)'};background:${ok ? 'var(--good)' : 'transparent'};color:#fff">${ok ? ICONS.check.replace('<svg', '<svg style="width:13px;height:13px"') : ''}</span>
          <span><span style="${ok ? 'text-decoration:line-through' : ''}">${text}</span>${more ? `<small class="guide-count">${more}</small>` : ''}</span></li>`).join('')}
      </ol>
      <button class="btn small" id="guideOpen" style="margin-top:10px;width:100%">Read the strategy guide</button>`;
    // Redrawn only when something changed, so a tap isn't lost to a redraw.
    if (box.dataset.html === html) return;
    box.dataset.html = html;
    box.style.cssText = `position:absolute;right:calc(var(--right) + 10px);top:calc(var(--top) + 74px);width:260px;padding:${folded ? '0' : '12px 14px'};z-index:12`;
    box.innerHTML = html;
    const toggle = box.querySelector<HTMLElement>('.guide-next, button.guide-head');
    if (toggle) toggle.onclick = () => {
      this.guideOpen = !this.guideOpen;
      this.updateGuide(true);
    };
    box.querySelector<HTMLElement>('#guideOpen')?.addEventListener('click', () => this.openGuide());
    const close = box.querySelector<HTMLElement>('.close');
    if (close) close.onclick = () => {
      this.guideDismissed = true;
      this.guideForced = false;
      try { localStorage.setItem('terraville.guide', 'done'); } catch { /* ignore */ }
      box.hidden = true;
    };
  }

  // ---- small feedback ------------------------------------------------------------

  /** The last pointer on the map was a finger (or a pen): the cost tip goes above it, where the hand doesn't cover it. */
  touchTips = false;

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
    const W = window.innerWidth;
    const H = window.innerHeight;
    let x: number;
    let y: number;
    if (this.touchTips) {
      x = sx - w / 2;
      y = sy - h - 48;
      if (y < 8) y = sy + 48; // too near the top: under the finger, well clear of it
    } else {
      x = sx + 18;
      y = sy + 20;
    }
    tip.style.left = `${Math.round(Math.max(8, Math.min(W - w - 8, x)))}px`;
    tip.style.top = `${Math.round(Math.max(8, Math.min(H - h - 8, y)))}px`;
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

  /** What to say when a save didn't work: this browser is blocking storage, or storage is probably full. */
  saveFailedText(): string {
    return storageAvailable()
      ? "Saving failed: this browser's storage is full. Delete snapshots or cities you no longer need in Save, open and share."
      : 'Saving failed. This browser is blocking storage.';
  }

  /**
   * A short notice at the top of the map. A warning carries the caution diamond. It stays long enough to read, at about
   * 238 words a minute (Brysbaert 2019, Journal of Memory and Language 109, 104047) plus a moment to notice it: 2.8 to
   * 7 seconds. It waits while the pointer is on it, and a tap or click puts it away.
   */
  toast(text: string, kind: 'info' | 'warn' = 'info'): void {
    const t = $(this.root, '#toast');
    t.innerHTML = `${kind === 'warn' ? '<span class="caution" aria-hidden="true"></span>' : ''}<span>${esc(text)}</span>`;
    t.classList.toggle('warn', kind === 'warn');
    t.classList.remove('hide');
    const words = text.trim().split(/\s+/).length;
    this.toastTimer = Math.min(7, Math.max(2.8, 1.6 + 0.26 * words));
    this.placeToast(t);
  }

  /**
   * Keep the toast off the checklist, the goal card and the editor's panel: on a phone it goes under whichever is up (it
   * is already under the stats), and in a wider window one that would run into the card moves left of it, between it and
   * the tools.
   */
  private placeToast(t: HTMLElement): void {
    t.style.top = '';
    t.style.left = '';
    t.style.maxWidth = '';
    if ($(this.root, '#topbar').hidden) return;
    // On a phone the editor's panel sits at the bottom, clear of the toast: going under it would cover the brushes.
    const ids = this.narrow() ? ['#guide', '#goal'] : ['#guide', '#goal', '#editorPanel'];
    const cards = ids.map((id) => $(this.root, id)).filter((c) => !c.hidden).map((c) => c.getBoundingClientRect());
    if (!cards.length) return;
    if (this.narrow()) {
      t.style.top = `${Math.round(Math.max(...cards.map((c) => c.bottom)) + 8)}px`;
      return;
    }
    const r = t.getBoundingClientRect();
    const card = cards.find((c) => c.left < r.right && r.left < c.right && c.top < r.bottom && r.top < c.bottom);
    if (!card) return;
    const from = $(this.root, '#toolbox').getBoundingClientRect().right + 8;
    const room = card.left - 8 - from;
    t.style.maxWidth = `${Math.round(room)}px`;
    t.style.left = `${Math.round(from + room / 2)}px`;
  }

  private hideToast(): void {
    this.toastTimer = 0;
    this.toastHover = false;
    $(this.root, '#toast').classList.add('hide');
  }

  // ---- modals -------------------------------------------------------------------------

  private openModal(spec: ModalSpec): HTMLElement {
    // A dialog that takes over from another hands focus back where the first one would have.
    const active = document.activeElement;
    const opener = this.modalOpen ? this.modalOpener : hasKeyboardFocus(active) ? active : null;
    this.modalOpener = null;
    this.closeModal();
    this.closeDropdown();
    const root = $(this.root, '#modalRoot');
    const width = spec.width ?? (spec.wide ? 860 : 0);
    const m = el(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1" ${width ? `style="width:min(${width}px,100%)"` : ''}>
      <header><div style="flex:1"><h2 id="modalTitle">${esc(spec.title)}</h2>${spec.sub ? `<div class="sub">${spec.sub}</div>` : ''}</div>
      ${spec.locked ? '' : `<button class="iconbtn" data-close aria-label="Close">${ICONS.close}</button>`}</header>
      <div class="body"></div></div>`);
    $(m, '.body').appendChild(spec.body);
    if (spec.foot?.length) {
      const f = el('<footer></footer>');
      for (const b of spec.foot) f.appendChild(b);
      m.appendChild(f);
    }
    const close = m.querySelector<HTMLElement>('[data-close]');
    if (close) close.onclick = () => this.closeModal();
    root.innerHTML = '';
    root.appendChild(m);
    root.hidden = false;
    this.modalOpen = true;
    this.modalLocked = !!spec.locked;
    this.modalClose = spec.onClose ?? null;
    this.modalOpener = opener;
    this.game.renderer.preview = null;
    this.cursorTip(0, 0, null);
    // The dialog itself takes focus, never a text box in it, which would bring up a phone's keyboard.
    m.focus({ preventScroll: true });
    return m;
  }

  closeModal(): void {
    const root = $(this.root, '#modalRoot');
    if (root.hidden) return;
    root.hidden = true;
    root.innerHTML = '';
    this.modalOpen = false;
    this.modalLocked = false;
    const back = this.modalOpener;
    this.modalOpener = null;
    const f = this.modalClose;
    this.modalClose = null;
    f?.();
    if (back?.isConnected && !this.modalOpen) back.focus({ preventScroll: true });
  }

  /** Tab and Shift+Tab go round the open dialog's controls instead of out to the map behind it. */
  private keepTabInside(e: KeyboardEvent): void {
    const m = this.root.querySelector<HTMLElement>('#modalRoot .modal');
    if (!m) return;
    const items = [...m.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length > 0);
    const at = document.activeElement;
    if (!items.length) {
      e.preventDefault();
      m.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (!m.contains(at) || (e.shiftKey ? at === first || at === m : at === last)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  /** Close whatever is on top (dropdown, dialog, log, inspect). Returns true if something closed. */
  closeTop(): boolean {
    if (this.dropdownEl) {
      this.closeDropdown();
      return true;
    }
    if (this.modalOpen) {
      if (!this.modalLocked) this.closeModal();
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

  /**
   * A Delete button that acts only on a second press, as nothing brings back what it deletes. `what` names it for a
   * screen reader ('Delete Willowmont'); `where` adds to the second press's wording, such as ' everywhere'.
   */
  private deleteBtn(what: string, act: () => void | Promise<void>, where = () => ''): HTMLButtonElement {
    const b = this.btn('Delete', 'small danger', () => {
      if (b.dataset.sure) return void act();
      b.dataset.sure = '1';
      const w = where();
      b.textContent = `${again()} to delete${w}`;
      b.setAttribute('aria-label', `${again()} to delete ${what}${w}`);
    });
    return named(b, `Delete ${what}`);
  }

  // Founding ------------------------------------------------------------------------------

  openFound(fromQuick: boolean): void {
    let diff: Difficulty['id'] = 'easy';
    const style = STYLE_NAMES[this.game.terrain.style];
    const body = el(`<div style="display:flex;flex-direction:column;gap:16px">
      ${fromQuick ? `<figure class="found-land"><canvas id="fLand" role="img" aria-label="Map of the land: ${esc(style.toLowerCase())}"></canvas>
        <figcaption><b>${esc(style)}</b>This land was generated at random. Shape it first in the terrain editor, or found the city as it is.</figcaption></figure>` : ''}
      <div class="field"><span><label for="fName">City name</label></span>
        <div class="seedrow"><input class="textin" id="fName" maxlength="28" value="${esc(randomCityName())}" spellcheck="false">
        <button class="iconbtn" id="fDice" aria-label="Another name" title="Another name">${ICONS.dice}</button></div></div>
      <div class="field"><span id="fDiffCap">Difficulty</span>
        <div class="choice" id="fDiff" role="radiogroup" aria-labelledby="fDiffCap">${DIFFICULTIES.map((d) => `<button role="radio" data-d="${d.id}" aria-checked="${d.id === diff}" tabindex="${d.id === diff ? 0 : -1}"><b>${d.name}</b><span>${money(d.funds)} to start</span><small>${difficultyNote(d)}</small></button>`).join('')}</div>
      </div>
      <label class="switch"><span>Random disasters<small>Fires, floods, tornadoes and worse, once the city has ${DISASTER_POP.toLocaleString()} residents. You can also set them off yourself.</small></span><input type="checkbox" id="fDis" checked></label>
    </div>`);
    // A phone has no minimap and the dialog covers the map: the land it would found on, drawn a pixel a tile.
    const land = body.querySelector<HTMLCanvasElement>('#fLand');
    const pic = land && this.game.minimap.picture();
    if (land && pic) {
      land.width = pic.width * 3;
      land.height = pic.height * 3;
      const ctx = land.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(pic, 0, 0, land.width, land.height);
    }
    $(body, '#fDice').onclick = () => ($<HTMLInputElement>(body, '#fName').value = randomCityName());
    // A group of radio buttons: one stop for Tab, the arrow keys move the choice.
    const choose = (b: HTMLElement) => {
      diff = b.dataset.d as Difficulty['id'];
      for (const x of body.querySelectorAll<HTMLElement>('[data-d]')) {
        x.setAttribute('aria-checked', String(x === b));
        x.tabIndex = x === b ? 0 : -1;
      }
    };
    $(body, '#fDiff').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-d]');
      if (b) choose(b);
    };
    $(body, '#fDiff').onkeydown = (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      e.stopPropagation(); // the arrow keys would also move the map
      const all = [...body.querySelectorAll<HTMLElement>('[data-d]')];
      const b = all[(all.findIndex((x) => x.dataset.d === diff) + step + all.length) % all.length];
      choose(b);
      b.focus();
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
    // With a mouse, typing replaces the suggested name. A touch screen would bring up its keyboard over the dialog, so
    // there the name waits for a tap.
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) window.setTimeout(() => $<HTMLInputElement>(body, '#fName').select(), 30);
  }

  /** Another tab opened this city, so this one has stopped. */
  cityTakenElsewhere(name: string): void {
    const body = el(`<p class="note" style="font-size:14px">${esc(name)} is open in another tab, so this tab has stopped to keep the two from saving over each other.</p>`);
    this.openModal({
      title: 'Open in another tab',
      body,
      locked: true,
      foot: [
        this.btn('Back to the title screen', '', () => {
          this.closeModal();
          this.game.showTitle();
        }),
        this.btn('Play it here instead', 'primary', async () => {
          if (await this.game.playHere()) this.closeModal();
          else this.toast(`The save of ${name} could not be read here.`, 'warn');
        }),
      ],
    });
  }

  /**
   * Leave for the title screen, saving the city on the way. When this browser can't keep it (storage blocked, or the
   * save failed), say so and offer a city code, or leaving anyway.
   */
  private confirmQuit(failed = false): void {
    const g = this.game;
    const city = g.mode === 'city';
    const blocked = city && !storageAvailable();
    const unsaved = blocked || failed;
    const text = !city ? 'Unsaved terrain will be lost.'
      : blocked ? 'This browser is blocking storage, so the city cannot be saved here.'
      : failed ? 'Saving the city failed. Storage may be full.'
      : g.settings.autosave ? 'The city is saved as you leave, and you can carry on from the title screen.'
      : 'Autosave is off, so this city is not saved. Use Save now first if you want to keep it.';
    const body = el(`<p class="note" style="font-size:14px">${text}${unsaved ? ' To keep it, save a city code in <button class="linkbtn" id="qFiles">Save, open and share</button> first.' : ''}</p>`);
    body.querySelector<HTMLElement>('#qFiles')?.addEventListener('click', () => this.openFiles());
    this.openModal({
      title: 'Leave for the title screen?',
      body,
      foot: [
        this.btn('Stay', '', () => this.closeModal()),
        unsaved
          ? this.btn('Leave anyway', 'danger', () => {
              this.closeModal();
              g.showTitle();
            })
          : this.btn('Leave', 'primary', async () => {
              this.closeModal();
              if (city && g.settings.autosave && !(await g.saveCity())) return this.confirmQuit(true);
              g.showTitle();
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
    box.style.cssText = 'position:absolute;right:calc(var(--right) + 10px);top:calc(var(--top) + 74px);width:270px;padding:11px 13px;z-index:12;display:flex;flex-direction:column;gap:6px';
    const left = Math.max(0, monthsLeft);
    const time = done === 'won' ? 'Won' : done === 'lost' ? 'Time ran out' : `${Math.floor(left / 12)}y ${left % 12}m left`;
    const col = done === 'lost' ? 'var(--critical)' : st.met ? 'var(--good)' : 'var(--caution)';
    box.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
        <b style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">${esc(s.name)}</b>
        <span class="num" style="font-size:12px;color:${done === 'lost' ? 'var(--critical-ink)' : 'var(--text)'}">${time}</span></div>
      <div style="font-size:13px">${st.status.split(' · ').map(esc).join(SEP)}</div>
      <div class="barrow" style="grid-template-columns:1fr"><div class="track" role="img" aria-label="Progress ${Math.round(st.progress * 100)}%"><i style="width:${Math.max(2, st.progress * 100)}%;background:${col}"></i></div></div>`;
  }

  scenarioResult(s: Scenario, st: GoalState, won: boolean): void {
    const city = this.game.world.city;
    const body = el(`<div style="display:flex;flex-direction:column;gap:10px">
      <p style="margin:0;font-size:15px">${won ? `${esc(successLine(s, city.month, city.scenario?.end ?? city.month))} The council is already naming a street after you.` : `The deadline for ${esc(s.name)} has passed without reaching the goal.`}</p>
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
          <p class="note" id="bFundNote" style="margin-top:6px"></p>
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
      $(body, '#bFundNote').innerHTML = this.fundingNote();
      const b = sim.stats.lastBudget;
      const y = sim.stats.yearBudget;
      const rows: [string, number, number][] = [
        ['Taxes', b.taxIncome, y.taxIncome],
        ['Roads and rail', -b.transport, -y.transport],
        ['Police', -b.police, -y.police],
        ['Fire', -b.fire, -y.fire],
        ['Schools, hospitals, parks', -b.services, -y.services],
        ['Stadium, seaport, airport', -b.landmarks, -y.landmarks],
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
        } else this.toast('Not enough money to repay that.', 'warn');
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
    this.openModal({ title: 'Budget', sub: `${dateLabel(city.month)}${SEP}the clock stops while this is open`, body, foot: [this.btn('Done', 'primary', () => this.closeModal())] });
  }

  /**
   * What the funding sliders do as they stand: a sentence for each one below full (what the cut costs the city, and
   * what it saves a month), or that all three are at full strength.
   */
  private fundingNote(): string {
    const sim = this.game.sim!;
    const f = this.game.world.city.funding;
    const full = sim.fullUpkeep();
    const cut = (['police', 'fire', 'transport'] as const).filter((k) => f[k] < 1);
    if (!cut.length) return 'Police, fire and roads at full strength.';
    return cut.map((k) => {
      const at = `${k === 'transport' ? 'Roads and rail' : k === 'police' ? 'Police' : 'Fire'} at ${Math.round(f[k] * 100)}%: `;
      const saves = full[k] * (1 - f[k]);
      const save = saves >= 0.5 ? ` Saves <span class="num">${money(saves)}</span>/mo.` : '';
      if (k !== 'transport') {
        if (!full[k]) return `${at}there are no stations yet.`;
        return `${at}stations cover less ground, so ${k === 'police' ? 'crime rises' : 'fires spread further'}.${save}`;
      }
      // The same chance a month the simulation rolls for each tile.
      const n = sim.crumbling(f.transport);
      const what = f.transport >= 0.9 ? 'nothing crumbles until they fall below 90%'
        : n >= 1.5 ? `about ${Math.round(n)} tiles a month crumble into rubble`
          : n >= 0.75 ? 'about a tile a month crumbles into rubble'
            : n > 0 ? `about a tile every ${Math.round(1 / n)} months crumbles into rubble` : 'there are no roads or rail to crumble yet';
      return `${at}${what}.${save}`;
    }).join('<br>');
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
      const people = (v: number) => Math.round(v).toLocaleString();
      // The names at the line ends are the legend's.
      lineChart($(body, '#ch1'), [
        { name: 'Residents', color: ZONE_COLORS.res, values: cut(h.res) },
        { name: 'Commercial jobs', color: ZONE_COLORS.com, values: cut(h.com) },
        { name: 'Industrial jobs', color: ZONE_COLORS.ind, values: cut(h.ind) },
      ], { startMonth: start, format: people, zero: true, whole: true });
      lineChart($(body, '#ch2'), [{ name: 'Funds', color: '#3987e5', values: cut(h.funds) }], { startMonth: start, format: money, money: true, whole: true });
      lineChart($(body, '#ch3'), [
        { name: 'Tax income', color: '#3987e5', values: cut(h.income) },
        { name: 'Spending', color: '#d95926', values: cut(h.expense) },
      ], { startMonth: start, format: money, zero: true, money: true, whole: true });
      lineChart($(body, '#ch4'), [
        { name: 'Crime', color: '#d55181', values: cut(h.crime).map((v) => Math.round((v / 255) * 100)) },
        { name: 'Pollution', color: '#c98500', values: cut(h.pollution).map((v) => Math.round((v / 255) * 100)) },
      ], { startMonth: start, format: (v) => String(Math.round(v)), zero: true, whole: true });
    };
    $(body, '#cRange').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-n]');
      if (!b) return;
      this.chartRange = Number(b.dataset.n);
      for (const x of body.querySelectorAll('[data-n]')) x.setAttribute('aria-pressed', String(x === b));
      draw();
    };
    this.openModal({ title: 'History', sub: `${esc(g.world.city.name)} since ${dateLabel(Math.max(0, g.world.city.month - h.pop.length))}`, body, wide: true });
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
    // Nobody to approve or worry yet: say so rather than show 50% of no one and an empty list.
    const empty = s.residents === 0;
    const body = el(`<div style="display:flex;flex-direction:column;gap:18px">
      <div class="cols">
        ${empty ? `<div>
          <h3>Mayor's approval</h3>
          <p class="note" style="font-size:14px">Nobody lives here yet. The report fills in once people move in.</p>
        </div>` : `<div>
          <h3>Mayor's approval</h3>
          <div style="display:flex;align-items:baseline;gap:10px"><span class="big">${approval}%</span><span class="note">${approval >= 70 ? 'People like how things are going.' : approval >= 45 ? 'Opinion is split.' : 'Residents are unhappy.'}</span></div>
          <div class="barrow" style="grid-template-columns:1fr;margin-top:10px"><div class="track"><i style="width:${approval}%;background:${approval >= 60 ? 'var(--good)' : approval >= 40 ? 'var(--warn)' : 'var(--critical)'}"></i></div></div>
        </div>`}
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
      ${empty ? '' : `<div>
        <h3>What people worry about</h3>
        <div class="bars">${s.problems.map((p) => {
          const to = WORRY_LAYERS[p.id];
          const inner = `<span>${p.label}</span><div class="track" role="img" aria-label="${p.label}: ${word(p.value)}"><i style="width:${Math.max(2, p.value)}%;background:${sev(p.value)}"></i></div><span class="v">${word(p.value)}</span>`;
          return to ? `<button class="barrow worry" data-to="${to}" title="${to === 'budget' ? 'Open the budget' : `Show the ${OVERLAYS.find((o) => o.id === to)!.name.toLowerCase()} layer`}">${inner}</button>` : `<div class="barrow">${inner}</div>`;
        }).join('')}</div>
      </div>`}
      <div class="cols">
        <dl class="kv">
          <dt>Commercial jobs</dt><dd>${s.comJobs.toLocaleString()}</dd>
          <dt>Industrial jobs</dt><dd>${s.indJobs.toLocaleString()}</dd>
          <dt>Unemployment</dt><dd>${Math.round(s.unemployment * 100)}%</dd>
          <dt>Zones (R/C/I)</dt><dd>${s.zones.res} / ${s.zones.com} / ${s.zones.ind}</dd>
        </dl>
        <dl class="kv">
          <dt>Power</dt><dd>${s.powerDemand.toLocaleString()} of ${s.powerSupply.toLocaleString()} MW</dd>
          <dt>Power grids</dt><dd>${s.powerGrids}${s.gridsShort ? `, <span style="color:var(--critical-ink)">${s.gridsShort} overloaded</span>` : ''}</dd>
          <dt>Unpowered zones</dt><dd>${s.unpowered}</dd>
          <dt>Average land value</dt><dd>${money(s.avgLandValue * 40)}/acre</dd>
          <dt>Fires burning</dt><dd>${s.fires}</dd>
        </dl>
      </div>
    </div>`);
    // A worry opens where to see it: its map layer, or the budget for taxes.
    body.addEventListener('click', (e) => {
      const to = (e.target as HTMLElement).closest<HTMLElement>('.worry')?.dataset.to;
      if (!to) return;
      this.closeModal();
      if (to === 'budget') this.openBudget();
      else this.setOverlay(to as Overlay);
    });
    this.openModal({ title: `${g.world.city.name} report`, sub: dateLabel(g.world.city.month), body, foot: [this.btn('Close', 'primary', () => this.closeModal())] });
  }

  // Files -----------------------------------------------------------------------------------

  openFiles(): void {
    const g = this.game;
    const drive = g.drive;
    const canStore = storageAvailable();
    const inGame = g.mode !== 'title';
    drive.prepare();
    const body = el(`<div style="display:flex;flex-direction:column;gap:18px">
      ${canStore ? '' : '<p class="note">This browser is blocking storage, so saves cannot be kept here. City codes still work: copy one somewhere safe and paste it back later.</p>'}
      ${inGame ? `<div><h3>Save</h3><div style="display:flex;gap:8px;flex-wrap:wrap" id="fSaveBtns"></div>
        ${g.mode === 'city' ? `<p class="note" style="margin-top:6px" id="fKept">${g.settings.autosave ? 'The city also saves itself every 90 seconds and whenever you leave the page.' : 'Autosave is off, so only Save now keeps this city.'}</p>` : ''}</div>` : ''}
      <div><h3>Your cities</h3><div class="slots" id="fCities"></div></div>
      <div id="fDrive"></div>
      <div id="fOtherBox"><h3>Snapshots and terrain on this device</h3><div class="slots" id="fOther"></div></div>
      ${inGame ? `<div><h3>Share this ${g.mode === 'city' ? 'city' : 'terrain'}</h3>
        <p class="note" style="margin-bottom:8px">A city code holds the whole map. Paste it into Open a city code on any device.</p>
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap"><button class="btn small" id="fMake">Create city code</button><button class="btn small" id="fCopy" disabled>Copy</button><button class="btn small" id="fDownload" disabled>Save as a file</button></div>
        <textarea class="code" id="fCode" readonly placeholder="The code appears here." aria-label="City code"></textarea></div>` : ''}
      <div><h3>Open a city code</h3>
        <textarea class="code" id="fPaste" placeholder="Paste a code that starts with TV1" aria-label="Paste a city code"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center">
          <button class="btn small primary" id="fOpen">Open code</button>
          <label class="btn small" style="position:relative;overflow:hidden">Open a text file<input type="file" id="fFile" accept=".txt,.tvc,text/plain" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>
          <span class="note" id="fErr" role="alert" style="color:var(--critical-ink)"></span>
        </div>
      </div>
    </div>`);

    const openLocal = async (id: string, name: string) => {
      // A snapshot is a copy of a city that may have played on since.
      if (!listSlots().find((s) => s.id === id)?.city) {
        const f = await loadSlot(id);
        if (f && olderCopy(f, id)) return;
      }
      try {
        await g.openSlot(id);
      } catch (e) {
        return this.toast((e as Error).message, 'warn');
      }
      this.closeModal();
      this.toast(`Opened ${name}.`);
    };

    /**
     * A copy of a city (a code or a snapshot) that this device, or Drive, has a later save of: opening it as it is
     * would replace that save at the next autosave, so ask first. True when it asked.
     */
    const olderCopy = (f: SaveFile, slotId: string | null): boolean => {
      let w: World;
      try {
        w = World.deserialize(f.world);
      } catch {
        return false;
      }
      const { id, name, month, founded } = w.city;
      if (f.mode !== 'city' || !founded || !id) return false;
      const later = Math.max(
        ...listSlots().filter((s) => s.city === id && Number.isFinite(s.date)).map((s) => s.date),
        ...(copies ?? []).filter((c) => c.city === id && Number.isFinite(c.date)).map((c) => c.date),
      );
      if (!(later > month)) return false;
      const open = (separate: boolean) => {
        this.closeModal();
        g.openCopy(f, slotId, separate);
        this.toast(separate ? `Opened ${name} as a separate city.` : `Opened ${name} as it was in ${dateLabel(month)}.`);
      };
      this.openModal({
        title: 'Open an older copy?',
        body: el(`<p class="note" style="font-size:14px">This is an older copy of ${esc(name)} (${dateLabel(month)}). Your save of ${esc(name)} is at ${dateLabel(later)}.</p>`),
        foot: [
          this.btn(`Go back to ${dateLabel(month)}`, 'danger', () => open(false)),
          this.btn('Open as a separate city', 'primary', () => open(true)),
        ],
      });
      return true;
    };

    // Cities: this device's own saves merged with the copies in Drive, newest first.
    let copies: DriveCopy[] | null = null;
    let listing = false;
    let listErr = '';
    const fetchCopies = () => {
      if (listing || !drive.hasToken()) return;
      listing = true;
      drive.list().then(
        (c) => {
          copies = c;
          listErr = '';
        },
        (e) => {
          // A fetch that can't reach Google says only 'Failed to fetch'.
          listErr = e instanceof TypeError ? UNREACHABLE : (e as Error).message || 'Could not reach Google Drive.';
        },
      ).finally(() => {
        listing = false;
        renderCities();
      });
    };
    const renderCities = () => {
      const box = $(body, '#fCities');
      type Row = { name: string; pop: number; date: number; local?: SlotMeta; remote?: DriveCopy; copies: number };
      const rows = new Map<string, Row>();
      for (const s of listSlots()) {
        if (s.mode !== 'city' || !(s.city || s.id === 'auto')) continue;
        rows.set(s.city ?? 'auto', { name: s.name, pop: s.pop, date: s.date, local: s, copies: 0 });
      }
      for (const c of copies ?? []) {
        const r: Row = rows.get(c.city) ?? { name: c.name, pop: c.pop, date: c.date, copies: 0 };
        r.copies++;
        if (!r.remote || c.saved > r.remote.saved) r.remote = c;
        rows.set(c.city, r);
      }
      const newest = (r: { local?: SlotMeta; remote?: DriveCopy }) => Math.max(r.local?.savedAt ?? 0, r.remote?.saved ?? 0);
      const list = [...rows.entries()].sort((a, b) => newest(b[1]) - newest(a[1]));
      box.innerHTML = '';
      if (!list.length) {
        box.innerHTML = `<p class="note">${listing ? 'Looking in Google Drive…' : 'No cities saved yet.'}</p>`;
      }
      for (const [city, r] of list) {
        // Open whichever copy is newer; a copy from another device wins by more than a moment.
        const useRemote = !!r.remote && (!r.local || r.remote.saved > r.local.savedAt + 2000);
        const show = useRemote ? r.remote! : null;
        const name = show ? show.name : r.name;
        const pop = show ? show.pop : r.local!.pop;
        const date = show ? show.date : r.local!.date;
        const where = !r.remote
          ? `On this device${r.local!.id === 'auto' ? ' (autosave)' : ''}${SEP}saved ${ago(r.local!.savedAt)}`
          : useRemote
            ? `${r.local ? 'Newer copy in Drive' : 'In Drive'}, from ${esc(r.remote.mine ? 'this device' : r.remote.label)}${SEP}saved ${ago(r.remote.saved)}`
            : `On this device and in Drive${SEP}saved ${ago(r.local!.savedAt)}`;
        const row = el(`<div class="slot"><b>${esc(name)}</b>
          <div class="actions"></div>
          <span class="meta num">${dateLabel(date)} · pop ${pop.toLocaleString()}</span>
          <span class="meta" style="grid-column:1/-1">${where}</span></div>`);
        const everywhere = () => !!r.remote && drive.hasToken();
        const del = this.deleteBtn(name, async () => {
          const all = everywhere();
          if (r.local) deleteSlot(r.local.id);
          if (all) {
            try {
              await drive.remove(city);
              copies = (copies ?? []).filter((c) => c.city !== city);
            } catch (e) {
              this.toast((e as Error).message || 'Could not delete it from Google Drive.', 'warn');
            }
          }
          renderCities();
        }, () => (everywhere() ? ' everywhere' : ''));
        $(row, '.actions').append(
          named(this.btn('Open', 'small primary', async () => {
            if (!useRemote) return openLocal(r.local!.id, name);
            try {
              await g.openFromDrive(r.remote!);
              this.closeModal();
              this.toast(`Opened ${name}, saved on ${r.remote!.mine ? 'this device' : r.remote!.label} ${ago(r.remote!.saved)}.`);
            } catch (e) {
              this.toast(`Could not open it from Google Drive: ${(e as Error).message}`, 'warn');
            }
          }), `Open ${name}`),
          del,
        );
        box.appendChild(row);
      }
      // Said once: the Google Drive section below shows Drive's own error.
      if (listErr && listErr !== drive.error) box.appendChild(el(`<p class="note"${listErr === UNREACHABLE ? '' : ' style="color:var(--critical-ink)"'}>${esc(listErr)}</p>`));
      else if (listing && list.length) box.appendChild(el('<p class="note">Looking in Google Drive…</p>'));
    };

    const renderOther = () => {
      const box = $(body, '#fOther');
      const slots = listSlots().filter((s) => !(s.mode === 'city' && (s.city || s.id === 'auto')));
      $(body, '#fOtherBox').hidden = !slots.length;
      box.innerHTML = '';
      for (const s of slots) {
        const row = el(`<div class="slot"><b>${esc(s.name)}</b>
          <div class="actions"></div>
          <span class="meta num">${s.mode === 'city' ? `${dateLabel(s.date)} · pop ${s.pop.toLocaleString()}` : 'Terrain'} · saved ${new Date(s.savedAt).toLocaleDateString()}</span></div>`);
        // Said with the date, since one city can have several snapshots.
        const what = s.mode === 'city' ? `the snapshot of ${s.name}, ${dateLabel(s.date)}` : `the terrain ${s.name}`;
        $(row, '.actions').append(
          named(this.btn('Open', 'small primary', () => openLocal(s.id, s.name)), `Open ${what}`),
          this.deleteBtn(what, () => {
            deleteSlot(s.id);
            renderOther();
          }),
        );
        box.appendChild(row);
      }
    };

    const renderDrive = () => {
      const box = $(body, '#fDrive');
      const st = drive.status();
      const err = drive.error ? `<p class="note" style="color:var(--critical-ink)">${esc(drive.error)}</p>` : '';
      if (st === 'unavailable') {
        box.innerHTML = location.href.startsWith(DRIVE_HOME) ? '' :
          `<h3>Google Drive</h3><p class="note">Keeping cities in Google Drive works in the copy at <a href="${DRIVE_HOME}" target="_blank" rel="noopener">terraville.junkdrawer.works</a>.</p>`;
        return;
      }
      if (st === 'off') {
        box.innerHTML = `<h3>Google Drive</h3>
          <p class="note">Keep your cities in your own Google Drive and carry on from any device. Terraville can see only the files it makes: a Terraville folder with one file per city. <a href="privacy.html" target="_blank" rel="noopener">Privacy</a></p>${err}
          <div style="display:flex;gap:8px;margin-top:8px"><button class="btn small primary" id="fDvGo">Connect Google Drive</button></div>`;
      } else if (st === 'signin') {
        box.innerHTML = `<h3>Google Drive</h3>
          <p class="note">Google signs Terraville out after an hour. Sign in again to keep cities syncing; they are safe on this device meanwhile.</p>${err}
          <div style="display:flex;gap:8px;margin-top:8px"><button class="btn small primary" id="fDvGo">Sign in to Google Drive</button><button class="btn small" id="fDvOff">Disconnect this device</button></div>`;
      } else {
        // While uploads fail, when the last one worked is beside the point.
        const failing = st === 'error' || st === 'waiting';
        const last = st === 'busy' ? 'Uploading…' : st === 'waiting' ? DRIVE_WAITING : st === 'error' ? '' : drive.lastUpload ? `Last upload ${ago(drive.lastUpload)}.` : 'Connected.';
        box.innerHTML = `<h3>Google Drive</h3>
          <p class="note">${last ? `${last} ` : ''}Every save also goes to <b>My Drive › Terraville</b>, one file per city for each device. Opening a city takes its newest copy.</p>${st === 'error' ? err : ''}
          <div style="display:flex;gap:8px;margin-top:8px">${failing ? '<button class="btn small primary" id="fDvRetry">Try again</button>' : ''}<button class="btn small" id="fDvOff">Disconnect this device</button></div>`;
      }
      const retry = box.querySelector<HTMLButtonElement>('#fDvRetry');
      if (retry) retry.onclick = () => void this.retryDrive();
      const go = box.querySelector<HTMLButtonElement>('#fDvGo');
      if (go) go.onclick = () => this.connectDrive();
      const off = box.querySelector<HTMLButtonElement>('#fDvOff');
      if (off) off.onclick = () => {
        drive.disconnect();
        copies = null;
        this.toast('Google Drive is disconnected on this device. Your cities stay here and in Drive.');
      };
    };

    // Re-draw when Drive signs in or finishes an upload, and look again after an upload.
    let was = drive.status();
    this.filesRefresh = () => {
      const now = drive.status();
      renderDrive();
      if (drive.hasToken() && (copies === null || (was === 'busy' && now !== 'busy'))) fetchCopies();
      else renderCities();
      was = now;
    };
    renderDrive();
    renderCities();
    renderOther();
    fetchCopies();

    const saveBtns = body.querySelector('#fSaveBtns');
    if (saveBtns) {
      if (g.mode === 'city') {
        saveBtns.appendChild(this.btn('Save now', 'primary', async () => {
          const ok = await g.saveCity();
          this.toast(ok ? `Saved${drive.connected ? ', and on its way to Google Drive' : ''}.` : this.saveFailedText(), ok ? 'info' : 'warn');
          renderCities();
        }));
      }
      saveBtns.appendChild(this.btn(g.mode === 'city' ? 'Save a snapshot' : 'Save this terrain', g.mode === 'city' ? '' : 'primary', async () => {
        const id = 's' + Date.now().toString(36);
        const ok = await g.saveTo(id);
        this.toast(ok ? (g.mode === 'city' ? 'Snapshot saved on this device.' : 'Saved.') : this.saveFailedText(), ok ? 'info' : 'warn');
        renderOther();
      }));
    }
    const make = body.querySelector<HTMLButtonElement>('#fMake');
    if (make) {
      make.onclick = async () => {
        const code = await encode(g.makeSaveFile());
        const ta = $<HTMLTextAreaElement>(body, '#fCode');
        ta.value = code;
        $<HTMLButtonElement>(body, '#fCopy').disabled = false;
        $<HTMLButtonElement>(body, '#fDownload').disabled = false;
        make.innerHTML = `<span>Code ready${SEP}${Math.round(code.length / 1024)} KB</span>`;
      };
      // A text file keeps a code whole where a message would cut it short; Open a text file reads it back.
      $(body, '#fDownload').onclick = () => {
        const name = (g.mode === 'city' ? g.world.city.name : `Terrain ${g.terrain.seed}`).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Terraville';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([$<HTMLTextAreaElement>(body, '#fCode').value], { type: 'text/plain' }));
        a.download = `${name}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
        if (olderCopy(f, null)) return;
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
    this.openModal({ title: inGame ? 'Save, open and share' : 'Open a saved city', body, wide: false, onClose: () => (this.filesRefresh = null) });
  }

  // Settings -----------------------------------------------------------------------------------

  /**
   * The keys that work here, as a list: the clock's (in the city), each toolbox group's letters with their tools' names,
   * then the map's and the editing keys. The tools come from the toolbox itself, so the list follows the mode.
   */
  private keysList(): string {
    const city = this.game.mode === 'city';
    const keys = (...k: string[]) => k.map((x) => `<kbd>${x}</kbd>`).join(' ');
    const rows: [string, string][] = city ? [[keys('Space'), 'Pause or resume'], [keys(',', '.'), 'Slower, faster']] : [];
    const groups = new Map<string, ToolDef[]>();
    for (const t of this.game.tools()) if (t.key) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
    for (const list of groups.values()) {
      const names = list.map((t, k) => (k ? t.name.charAt(0).toLowerCase() + t.name.slice(1) : t.name));
      rows.push([keys(...list.map((t) => t.key!.toUpperCase())), names.join(', ')]);
    }
    if (city) rows.push([keys('Right-click'), 'Bulldoze what is under the cursor'], [keys('Shift drag'), 'Bulldoze an area, any tool']);
    rows.push(
      [keys('Arrows'), 'Move the map'],
      [keys('+', '−'), 'Zoom'],
      [keys('[', ']'), city ? 'Level land brush size' : 'Brush size'],
      [keys('Ctrl Z'), 'Undo'],
      [`${keys('Ctrl Shift Z')} or ${keys('Ctrl Y')}`, 'Redo'],
      [keys('Esc'), 'Cancel or close'],
    );
    return `<dl class="keys">${rows.map(([k, what]) => `<dt>${k}</dt><dd>${what}</dd>`).join('')}</dl>`;
  }

  openSettings(): void {
    const g = this.game;
    const s = g.settings;
    const sw = (id: keyof typeof s, label: string, hint: string) =>
      `<label class="switch"><span>${label}<small>${hint}</small></span><input type="checkbox" data-set="${id}" ${s[id] ? 'checked' : ''}></label>`;
    const body = el(`<div class="cols">
      <div>
        <h3>Options</h3>
        ${sw('sound', 'Sound effects', 'Clicks, construction and sirens.')}
        ${sw('traffic', 'Traffic and vehicles', 'Cars on busy roads.')}
        ${sw('night', 'Day and night', 'Streetlights and lit windows after dark. Time stops when paused.')}
        ${sw('grid', 'Tile grid', 'Faint lines between tiles when zoomed in.')}
        ${sw('contours', 'Contour lines in the city', 'Always on in the terrain editor.')}
        ${sw('autosave', 'Autosave', 'Every 90 seconds, at the end of each year, and when you leave the page. Each city keeps its own save.')}
      </div>
      <div>
        ${touchScreen() ? TOUCH_HELP : ''}
        <h3>Keys</h3>
        ${this.keysList()}
        <p class="note" style="margin-top:12px">Right-drag, middle-drag or Space-drag moves the map with any tool.</p>
        ${touchScreen() ? '' : TOUCH_HELP}
      </div>
    </div>`);
    body.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const k = t.dataset.set as keyof typeof s | undefined;
      if (!k) return;
      s[k] = t.checked;
      g.saveSettings();
    });
    const m = this.openModal({ title: 'Settings', body, foot: [this.btn('Done', 'primary', () => this.closeModal())] });
    $(m, '.body').appendChild(el(JD_FOOT));
  }
}

export { SPEED_NAMES };

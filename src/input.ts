// Mouse, touch and keyboard. Left drag uses the current tool; right or
// middle drag, space-drag, or a one-finger drag with the inspect tool pans;
// two fingers pinch to zoom.
import { hasKeyboardFocus, watchFocus } from './focus';
import type { Game } from './game';

/** A touch brush waits this long, or for the finger to move this far, before it changes the land. */
const BRUSH_WAIT_MS = 100;
const BRUSH_SLOP = 6; // px
/** A second finger this soon after a touch brush stroke began makes it a pinch, and the stroke is taken back. */
const STROKE_UNDO_MS = 250;

interface Ptr {
  x: number;
  y: number;
  type: string;
}

export class Input {
  private pointers = new Map<number, Ptr>();
  /**
   * 'rclick': right button down, either a quick bulldoze or, once it moves, a pan. 'brushwait': one finger down with
   * a brush, not yet started in case a second finger turns it into a pinch.
   */
  private mode: 'none' | 'tool' | 'pan' | 'pinch' | 'maybe' | 'rclick' | 'brushwait' = 'none';
  private start = { x: 0, y: 0, camX: 0, camY: 0 };
  /** When the finger went down for 'brushwait', and when a touch brush stroke began (performance.now). */
  private downAt = 0;
  private strokeAt = -Infinity;
  private pinch = { d: 1, zoom: 1, cx: 0, cy: 0, tx: 0, ty: 0 };
  private space = false;
  /** Space was used to drag the map, so releasing it should not toggle pause. */
  private spacePanned = false;
  private keys = new Set<string>();

  constructor(private game: Game, private canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.cancel(e));
    canvas.addEventListener('pointerleave', (e) => {
      if (this.mode === 'none') {
        this.game.renderer.hover = null;
        // A lifted finger leaves too, after saying what it built.
        if (e.pointerType === 'mouse' || !this.game.showingBuilt) this.game.ui.cursorTip(0, 0, null);
        if (this.game.tool().kind !== 'brush' && !this.game.proposing) this.game.renderer.preview = null;
      }
    });
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.keydown(e));
    watchFocus();
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key);
      if (e.key === ' ') {
        const g = this.game;
        if (this.space && !this.spacePanned && g.mode === 'city' && !g.ui.modalOpen) g.togglePause();
        this.space = false;
        this.spacePanned = false;
      }
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.space = false;
    });
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private panByTool(): boolean {
    const id = this.game.tool().id;
    return id === 'query' || id === 'pan';
  }

  private down(e: PointerEvent): void {
    const g = this.game;
    if (g.mode === 'title') return;
    // A finger or a button on the map takes the camera back from a move in progress.
    g.renderer.stopFlight();
    g.audio.unlock();
    g.ui.hideToolTip();
    // A click on the map that closes a menu does nothing else. On a phone the news log closes too, out of the way.
    if (g.ui.closeDropdownIfOpen()) return;
    g.ui.closeLogIfCompact();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, { ...p, type: e.pointerType });
    g.ui.touchTips = e.pointerType !== 'mouse';
    if (this.pointers.size === 2) {
      // Second finger: abandon any tool drag and start pinching. A brush that had not started yet does nothing, and
      // one that started a moment ago is taken back, ground, money and all.
      if (this.mode === 'tool') {
        if (performance.now() - this.strokeAt < STROKE_UNDO_MS) g.abortStroke();
        else g.cancelTool();
      }
      const [a, b] = [...this.pointers.values()];
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const t = g.renderer.screenToTile(cx, cy);
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: g.renderer.cam.zoom, cx, cy, tx: t.x, ty: t.y };
      this.mode = 'pinch';
      return;
    }
    if (this.pointers.size > 2) return;
    const cam = g.renderer.cam;
    this.start = { x: p.x, y: p.y, camX: cam.x, camY: cam.y };
    if (e.button === 2 && !this.space) {
      this.mode = 'rclick';
      return;
    }
    if (e.button === 1 || e.button === 2 || this.space) {
      if (this.space) this.spacePanned = true;
      this.mode = 'pan';
      this.canvas.classList.add('grabbing');
      return;
    }
    if (e.shiftKey && e.button === 0 && g.mode === 'city') {
      // Shift-drag clears an area with whatever tool is selected.
      g.useToolOnce('bulldoze');
      this.mode = 'tool';
      const t = g.renderer.screenToTile(p.x, p.y);
      g.pointerDown(t.x, t.y, p.x, p.y);
      return;
    }
    if (this.panByTool()) {
      // Could be a click (inspect) or a drag (pan); decide on movement.
      this.mode = 'maybe';
      return;
    }
    if (e.pointerType === 'touch' && g.tool().kind === 'brush') {
      // A pinch starts with one finger too: wait a moment before the brush touches the ground.
      this.mode = 'brushwait';
      this.downAt = performance.now();
      return;
    }
    this.mode = 'tool';
    this.strokeAt = -Infinity;
    const t = g.renderer.screenToTile(p.x, p.y);
    g.pointerDown(t.x, t.y, p.x, p.y, e.pointerType !== 'mouse');
  }

  /** The finger has stayed down long enough, or moved far enough, to be a brush stroke rather than a pinch. */
  private startStroke(): void {
    const g = this.game;
    const waited = (performance.now() - this.downAt) / 1000;
    this.mode = 'tool';
    this.strokeAt = performance.now();
    const t = g.renderer.screenToTile(this.start.x, this.start.y);
    g.strokeDown(t.x, t.y, this.start.x, this.start.y, waited);
  }

  private move(e: PointerEvent): void {
    const g = this.game;
    const p = this.local(e);
    const ptr = this.pointers.get(e.pointerId);
    if (ptr) {
      ptr.x = p.x;
      ptr.y = p.y;
    }
    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const r = g.renderer;
      r.cam.zoom = Math.max(r.minZoom(), Math.min(96, this.pinch.zoom * (d / this.pinch.d)));
      // Keep the tile under the fingers' midpoint under it.
      r.cam.x = this.pinch.tx - (cx - r.cssW / 2) / r.cam.zoom;
      r.cam.y = this.pinch.ty - (cy - r.cssH / 2) / r.cam.zoom;
      r.clampCamera();
      return;
    }
    if (this.mode === 'brushwait' && Math.hypot(p.x - this.start.x, p.y - this.start.y) > BRUSH_SLOP) this.startStroke();
    if ((this.mode === 'maybe' || this.mode === 'rclick') && Math.hypot(p.x - this.start.x, p.y - this.start.y) > 5) {
      this.mode = 'pan';
      this.canvas.classList.add('grabbing');
    }
    if (this.mode === 'pan') {
      const z = g.renderer.cam.zoom;
      g.renderer.cam.x = this.start.camX - (p.x - this.start.x) / z;
      g.renderer.cam.y = this.start.camY - (p.y - this.start.y) / z;
      g.renderer.clampCamera();
      return;
    }
    if (g.mode === 'title') return;
    // Hovering (mouse) or dragging a tool.
    if (e.pointerType === 'mouse') g.ui.touchTips = false;
    else if (this.mode !== 'tool') return;
    const t = g.renderer.screenToTile(p.x, p.y);
    g.pointerMove(t.x, t.y, p.x, p.y);
  }

  private up(e: PointerEvent): void {
    const g = this.game;
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.mode === 'pinch') {
      if (this.pointers.size === 0) this.mode = 'none';
      return;
    }
    // A quick tap with a brush: a short stroke, as long as the finger was down.
    if (this.mode === 'brushwait') this.startStroke();
    if (this.mode === 'maybe') {
      const t = g.renderer.screenToTile(p.x, p.y);
      g.pointerDown(t.x, t.y, p.x, p.y);
    } else if (this.mode === 'rclick') {
      // A right-click without dragging bulldozes whatever is under it.
      const t = g.renderer.screenToTile(p.x, p.y);
      g.quickBulldoze(t.x, t.y, p.x, p.y);
    } else if (this.mode === 'tool') {
      const t = g.renderer.screenToTile(p.x, p.y);
      g.pointerUp(t.x, t.y, p.x, p.y);
      // A finger that lifts leaves no preview behind, though the tip saying what it built stays for its moment.
      if (e.pointerType !== 'mouse') {
        if (!g.proposing) g.renderer.preview = null;
        if (!g.showingBuilt) g.ui.cursorTip(0, 0, null);
      }
    }
    this.mode = 'none';
    this.canvas.classList.remove('grabbing');
  }

  private cancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.mode === 'tool') this.game.cancelTool();
    if (this.pointers.size === 0) this.mode = 'none';
    this.canvas.classList.remove('grabbing');
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const g = this.game;
    if (g.mode === 'title') return;
    g.renderer.stopFlight();
    const p = this.local(e);
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX) || e.deltaMode !== 0) {
      const k = e.deltaMode === 1 ? 0.05 : 0.0022;
      g.renderer.zoomAt(p.x, p.y, Math.exp(-e.deltaY * k * (e.ctrlKey ? 2.5 : 1)));
    } else {
      // Horizontal trackpad scroll pans.
      g.renderer.cam.x += e.deltaX / g.renderer.cam.zoom;
      g.renderer.clampCamera();
    }
    const t = g.renderer.screenToTile(p.x, p.y);
    g.pointerMove(t.x, t.y, p.x, p.y);
  }

  private keydown(e: KeyboardEvent): void {
    const g = this.game;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    // Space and Enter press a button that has keyboard focus. After a click, Space still pauses rather than pressing
    // the clicked tool again, and letter keys are hotkeys wherever focus is.
    if ((e.key === ' ' || e.key === 'Enter') && hasKeyboardFocus(target) && target.closest('button, a')) return;
    // Dialogs opened from the title screen close with Escape too.
    if (g.mode === 'title') {
      if (e.key === 'Escape') g.ui.closeTop();
      return;
    }
    g.renderer.stopFlight();
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (k === 'z' || k === 'Z')) {
      e.preventDefault();
      if (g.ui.modalOpen || g.dragging) return;
      if (e.shiftKey) g.redo();
      else g.undo();
      return;
    }
    if (mod && (k === 'y' || k === 'Y')) {
      e.preventDefault();
      if (g.ui.modalOpen || g.dragging) return;
      g.redo();
      return;
    }
    if (mod) return;
    if (k === 'Escape') {
      if (g.ui.closeTop()) return;
      g.cancelTool();
      g.setTool(g.mode === 'editor' ? 'pan' : 'query');
      return;
    }
    if (g.ui.modalOpen) return;
    if (k === ' ') {
      e.preventDefault();
      // Pause toggles on release, unless Space was held to drag the map.
      if (!this.space) this.spacePanned = this.mode !== 'none';
      this.space = true;
      return;
    }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      this.keys.add(k);
      return;
    }
    if (k === '+' || k === '=') return g.renderer.zoomAt(g.renderer.cssW / 2, g.renderer.cssH / 2, 1.25);
    if (k === '-' || k === '_') return g.renderer.zoomAt(g.renderer.cssW / 2, g.renderer.cssH / 2, 0.8);
    if (k === '0') return g.fitMap();
    if (k === '[') return g.ui.nudgeBrush(-0.5);
    if (k === ']') return g.ui.nudgeBrush(0.5);
    // Slower stops at Slow: it never pauses, and never starts a paused clock.
    if (g.mode === 'city' && (k === '<' || k === ',')) {
      if (g.speed > 0) g.setSpeed(Math.max(1, g.speed - 1));
      return;
    }
    if (g.mode === 'city' && (k === '>' || k === '.')) return g.setSpeed(g.speed + 1);
    const tool = g.tools().find((t) => t.key === k.toLowerCase());
    if (tool) {
      g.setTool(tool.id);
      g.audio.play('click');
    }
  }

  /** Keyboard panning, and a touch brush that has waited long enough, once per frame. */
  update(dt: number): void {
    if (this.mode === 'brushwait' && performance.now() - this.downAt >= BRUSH_WAIT_MS) this.startStroke();
    if (!this.keys.size) return;
    const g = this.game;
    const speed = (620 * dt) / g.renderer.cam.zoom;
    if (this.keys.has('ArrowLeft')) g.renderer.cam.x -= speed;
    if (this.keys.has('ArrowRight')) g.renderer.cam.x += speed;
    if (this.keys.has('ArrowUp')) g.renderer.cam.y -= speed;
    if (this.keys.has('ArrowDown')) g.renderer.cam.y += speed;
    g.renderer.clampCamera();
  }
}

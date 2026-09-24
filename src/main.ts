// Boot: build the page, wire the game, start the frame loop.
import { Game } from './game';
import { Input } from './input';
import type { SaveFile } from './save';
import { UI, buildShell } from './ui/ui';

interface HotData {
  file?: SaveFile;
  speed?: number;
}

interface HotApi {
  ready?: (fn: (data: HotData) => void) => void;
  snapshot?: (fn: () => HotData) => void;
  data?: HotData;
}

declare global {
  interface Window {
    claude?: { hot?: HotApi };
    __terraville?: Game;
  }
}

function start(hot: HotData): void {
  const root = document.getElementById('app')!;
  const { map, minimap } = buildShell(root);
  const game = new Game(map, minimap);
  const ui = new UI(game, root);
  game.ui = ui;
  const input = new Input(game, map);
  game.renderer.resize();
  window.addEventListener('resize', () => {
    game.renderer.resize();
    game.renderer.clampCamera();
  });
  let restored = false;
  if (hot && hot.file) {
    try {
      game.loadFile(hot.file);
      if (typeof hot.speed === 'number') game.setSpeed(hot.speed);
      restored = true;
    } catch {
      restored = false;
    }
  }
  if (!restored) game.showTitle();
  window.claude?.hot?.snapshot?.(() => (game.mode === 'title' ? {} : { file: game.makeSaveFile(), speed: game.speed }));
  window.__terraville = game;

  let last = performance.now();
  let failures = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      input.update(dt);
      game.frame(dt);
      ui.tick(dt);
    } catch (e) {
      // Keep the loop alive; say so once rather than freezing silently.
      console.error(e);
      if (failures++ === 0) ui.toast('Something went wrong. Save a city code from the menu to be safe.', 'warn');
      if (game.speed > 0 && failures > 30) game.setSpeed(0);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

const hot = window.claude?.hot;
if (hot?.ready) hot.ready(start);
else start(hot?.data ?? {});

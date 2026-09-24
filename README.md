# Terraville

A city builder in the spirit of the 1989 original and its companion terrain editor, rebuilt for the browser with a few modern touches.

Open `index.html` in any current browser. It is a single self-contained file: no server, no install.

## What's in it

**Terrain editor**
- Five landscape styles (coastline, island, archipelago, lake country, river valley), each generated from a seed you can type or roll.
- Sliders for sea level, mountains, ruggedness, rivers, lakes and forest. Every change regenerates the map instantly.
- Sculpting brushes: raise, lower, smooth, flatten, roughen. Paint water, dry land, forest, or clear trees. Drop a spring on a hilltop and a river finds its own way downhill.
- Real elevation with hillshading and contour lines. Beaches form on low coasts; rivers widen as they run.
- Undo and redo through everything, including regenerations.

**City**
- The classic loop: residential, commercial and industrial zones grow from vacant lots to cottages, main streets, factories and towers when they have power, road access, a workable commute and demand on the RCI meter.
- Roads, rail (trips by rail add no car traffic) and power lines, drawn by dragging. Straight bridges over water. Zones pass power to neighbours, as in the original.
- Coal, nuclear, wind and solar power, each with a capacity in MW. Brownouts cut off the far end of the grid first.
- Police, fire, schools, hospitals, parks, a stadium, a seaport and an airport. Big cities stall without the last three, like they used to.
- Pollution, crime, land value, traffic, density and service coverage maps, viewable as overlays.
- Monthly budget with tax rate, funding sliders for police, fire and roads (underfunded roads crumble), and loans.
- Fires that spread, floods on low shores, tornadoes, earthquakes, a monster drawn to pollution, and nuclear meltdowns. Toggle random disasters or set one off yourself.
- History charts, a city report with approval and residents' top worries, and a news ticker that can jump to the scene.
- Terraforming in the city: level hillsides for a price.

**Modern bits**
- Smooth zoom from the whole map down to street level, with detail that adapts to the zoom.
- Animated traffic on busy roads, trains, departing planes, boats, smoke and wind turbines.
- Drag to zone many lots at once, with live cost and a reason when something can't be built.
- Autosave, named save slots, and city codes: the whole map compressed into text you can paste on another device.
- Touch support: pinch to zoom, two fingers to move.
- A starter checklist for the first few minutes.

## Controls

| Input | Action |
|---|---|
| Left drag | Use the current tool |
| Right drag, middle drag, Space + drag | Move the map |
| Wheel, pinch | Zoom |
| `1` `2` `3` | Residential, commercial, industrial |
| `R` `T` `P` | Road, rail, power line |
| `B` / `Q` | Bulldoze / inspect |
| `Space` | Pause or resume |
| `,` `.` | Slower, faster |
| `[` `]` | Brush size |
| `Ctrl+Z`, `Ctrl+Shift+Z` | Undo, redo |
| `Esc` | Cancel, close |

## Development

```sh
npm install
npm run build        # writes index.html (and dist/page.html, a body-only copy)
npm test             # unit checks for terrain, power, traffic, saves, disasters
npm run bot -- 30    # a bot plays 30 years and prints a yearly summary
npx tsc --noEmit     # typecheck
```

Source lives in `src/`:

| File | What it does |
|---|---|
| `terrain.ts` | Terrain generation (simplex noise, priority-flood drainage for rivers and lakes) and the sculpting brushes |
| `world.ts` | The map, buildings, placement rules, serialization and undo snapshots |
| `sim.ts` | Weekly simulation: power, traffic, pollution, crime, land value, growth, demand, budget, advice |
| `disasters.ts` | Fires, floods, tornadoes, earthquakes, the monster, meltdowns |
| `tools.ts` | Turning drags and clicks into priced changes |
| `game.ts` | Modes, the tool state machine, undo, the clock, autosave |
| `render/` | Chunk-cached canvas renderer, procedural sprites, terrain painter, vehicles, minimap |
| `ui/` | Top bar, toolbox, dialogs and charts |

Everything is drawn in code. There are no image assets.

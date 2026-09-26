# Terraville

A city builder in the spirit of the 1989 original and its companion terrain editor, rebuilt for the browser with a few modern touches.

Play it at [junkdrawer.works/terraville](https://junkdrawer.works/terraville/), or open `index.html` in any current browser. It is a single self-contained file: no server, no install.

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
- Coal, nuclear, wind and solar power, each with a capacity in MW. Each connected grid has to power itself, and brownouts cut off its far end first. Inspect and the Power grid layer show which grid is short.
- Police, fire, schools, hospitals, parks, a stadium, a seaport and an airport. Big cities stall without the last three, like they used to.
- Pollution, crime, land value, traffic, density and service coverage maps, viewable as overlays.
- Monthly budget with tax rate, funding sliders for police, fire and roads (underfunded roads crumble), and loans.
- Fires that spread, floods on low shores, tornadoes, earthquakes, a monster drawn to pollution, and nuclear meltdowns. Toggle random disasters or set one off yourself.
- History charts, a city report with approval and residents' top worries, and a news ticker that can jump to the scene.
- Terraforming in the city: level hillsides for a price.
- Undo and redo for the last 25 actions, even while the clock runs. Undo puts back only the area an action touched, so the rest of the city keeps growing. The cost is refunded if you undo within three game months.

**Challenges**, after the original's scenarios, each a ready-made city with a goal and a deadline:
- *Boomtown* (1900): grow an empty coast to 12,000 residents in 15 years.
- *Gridlock* (1955): untangle downtown traffic without losing people.
- *Smog Valley* (1968): clean the air without killing the jobs.
- *Aftershock* (1989): rebuild after an earthquake and keep growing.
- *Monster Bay* (1957): something in the bay is drawn to smoke, and it keeps coming back.

**Modern bits**
- Smooth zoom from the whole map down to street level, with detail that adapts to the zoom.
- Animated traffic on busy roads, trains, departing planes, boats, smoke and wind turbines.
- A day and night cycle: streetlights and lit windows after dark.
- Commuters spread across the city's job centres, so traffic piles up on the arterials into downtown.
- Drag to zone many lots at once, with live cost and a reason when something can't be built.
- Every city keeps its own save, updated every 90 seconds, at each year's end and whenever you leave the page. Snapshots and city codes (the whole map compressed into text you can paste on another device) are there too.
- Optional Google Drive sync, so you can carry on with a city on another device. See below.
- Touch support: pinch to zoom, two fingers to move.
- A starter checklist for the first few minutes.

## Google Drive sync

In **Menu › Save, open and share**, choose **Connect Google Drive**. From then on every save of a city also goes to a `Terraville` folder in your Drive, as a city code in a text file. Each device writes its own file per city, such as `Riverton (iPhone).txt`, so two devices never overwrite each other. On another device, connect Drive the same way: the dialog lists every city with where its newest copy is, and the title screen's **Continue** offers a newer copy from another device when there is one.

- Terraville asks Google only for `drive.file`, so it can reach the files it made and nothing else in your Drive. [privacy.html](privacy.html) says the same for anyone using it.
- Google signs the page out after an hour. Your city keeps saving on the device meanwhile; the cloud in the top bar (or a dot on the menu, on a phone) turns amber, and one tap signs back in and uploads what waited.
- Sync works only where Google accepts the OAuth client: `GOOGLE_CLIENT_ID` in `src/drive.ts` is the junkdrawer.works client that Shelfmark also uses, authorised for `https://junkdrawer.works`. A copy served from anywhere else shows where to go instead. To run it elsewhere, create a Web client in Google Cloud with the Drive API enabled and the `drive.file` scope, add your origin under **Authorized JavaScript origins**, and put its ID and origin in `src/drive.ts`.
- Browser saves belong to the address the game is served from. Cities saved while it lived at `markjf99702.github.io` stay with that address, which now redirects here, so they can't be reached. Drive sync is the way around that from now on.

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
npm test             # unit checks for terrain, power, traffic, saves, undo, disasters, Drive sync
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
| `scenarios.ts` | The challenges and the builder that lays out their starting cities |
| `game.ts` | Modes, the tool state machine, undo, the clock, autosave |
| `save.ts` | Saves in this browser, and city codes |
| `drive.ts` | Google Drive sync: sign-in, uploads, listing and downloads |
| `render/` | Chunk-cached canvas renderer, procedural sprites, terrain painter, vehicles, minimap |
| `ui/` | Top bar, toolbox, dialogs and charts |

Everything is drawn in code. There are no image assets.

`index.html` is the built game and is committed, so GitHub Pages can serve the repository root as is (`.nojekyll` skips the Jekyll step). Rebuild it with `npm run build` after changing anything in `src/`.

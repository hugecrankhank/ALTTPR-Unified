# ALTTPR Unified — emulator + Hutch tracker in one page

A proof of concept that runs A Link to the Past (randomizer seeds) in the browser
with the Hutch-ALTTPR item and map trackers autotracking alongside it. No SNI,
QUsb2Snes, Lua scripts, or second window needed.

## Run it

It must be served over HTTP (opening `index.html` as a file won't work, because
the browser blocks the tracker frames from talking to the page).

```bash
cd alttp-unified
python3 -m http.server 8080      # or: npx serve .
```

Open http://localhost:8080. Then either:

- **Generate a seed in the app.** Pick settings in the **Randomizer** bar, press
  **Base ROM…** once to choose your own Japanese 1.0 ALttP ROM, then press
  **Generate & Play**. The trackers are set up to match the seed automatically.
- **Play a seed you already have.** Click **Load ROM…** and pick the `.sfc`,
  then set **World** and **Dungeon items** in the top bar to match it.

It also works as a static site (GitHub Pages, Netlify, etc.), which lets you
test from any device.

## How it works

```
index.html
├── EmulatorJS (snes9x core, from cdn.emulatorjs.org)
├── bridge/sni-bridge.js   ← reads emulator memory, speaks usb2snes addresses
└── <iframe> tracker/itemtracker.html, tracker/map.html   (Hutch, unmodified)
        └── bridge/sni-shim.js  ← swaps WebSocket for an in-page fake SNI
```

1. **Finding WRAM.** EmulatorJS doesn't export the core's RAM pointer. The
   bridge takes one save-state snapshot, finds the tagged `RAM:131072:` block
   in it (snes9x's snapshot format), then searches the WASM heap for that
   exact 128 KB block. From then on reads are direct views into live memory.
   It re-verifies every 5 s and relocates if needed; if the heap search ever
   fails it falls back to throttled snapshots (status pill turns yellow).
2. **Fake SNI.** Hutch connects to `ws://localhost:23074` and sends usb2snes
   JSON (`DeviceList`, `Attach`, `GetAddress`). The shim answers those from
   the bridge using SD2SNES address mapping:
   `F50000+` → WRAM, `E00000+` → SRAM, `000000+` → ROM file.
   Because Hutch thinks it's talking to SNI, its tracker code is untouched,
   so upstream tracker updates can be dropped straight into `tracker/`.

The only change to the Hutch files is one `<script>` line at the top of
`itemtracker.html`, `map.html`, `timer.html` and `broadcast.html`. Opened
outside this app, the shim does nothing and the tracker uses real SNI.

## The randomizer

`randomizer/` is a JavaScript port of the official ALttPR generator
([alttp_vt_randomizer](https://github.com/sporchia/alttp_vt_randomizer), the code
behind alttpr.com, build 2024-02-18) and runs entirely in the browser, in a
Web Worker.

```
randomizer/
├── app.js            ← the settings bar: base ROM, generate, patch, boot, downloads
├── worker.js         ← runs generate() off the main thread
├── generate.js       ← settings + seed → patch + spoiler (mirrors the alttpr.com API)
├── core/             ← Item, Location, Region, World, Randomizer, Rom, Text, …
├── regions/, worlds/ ← No Glitches logic for Standard / Open / Inverted / Retro
├── data/             ← base-patch.bin, config, text strings
├── tools/            ← converters, base-patch builder, PHP reference harness
└── test/             ← parity tests against the PHP original
```

How a seed is made:

1. Your Japanese 1.0 ROM (MD5 `03a63945…`) is stored in IndexedDB the first
   time you pick it. It never leaves the browser.
2. It's expanded to 2 MB and the base patch is applied. The base patch is
   z3randomizer (commit `dcb0a2b`, the version alttpr.com pins) assembled with
   asar; the result is checked against alttpr.com's base ROM MD5 (`edc01f3d…`).
3. The generator places items, writes the seed data, and returns a patch and
   spoiler. Heart beep, menu speed and quickswap are applied, then the checksum.
4. The ROM boots in the emulator and both trackers reload with the seed's
   world state, dungeon item shuffle, sword mode and GT crystal requirement.

**Same seed number + same settings = the same game**, so a seed can be shared
by its number. Some seeds can't be completed by the generator (the original
does this too); random seeds just roll again.

Supported: every alttpr.com option for No Glitches logic (world state, goal,
crystal requirements, swords, item placement, dungeon items, accessibility,
item pool and functionality, hints). Not included: glitched logic, entrance
shuffle, enemizer/boss shuffle, multiworld, tournament/race ROMs.

### Verifying the port

The port keeps the original's structure and order of operations, and the PHP
original can be run with the same seeded random number generator. For the same
settings and seed, both produce the same ROM bytes and the same spoiler:

```bash
git clone https://github.com/sporchia/alttp_vt_randomizer ../alttp_vt_randomizer
export VT_DIR=$PWD/../alttp_vt_randomizer         # needs PHP 8.1+
cd randomizer
node test/compare.mjs '{"mode":"inverted","dungeon_items":"full"}' 1 2 3
node test/logic.mjs '{"mode":"standard"}' 200     # per-location access logic
node test/sweep.mjs one                           # every option, one at a time
node test/sweep.mjs random 100                    # random combinations
```

Regenerating code from the PHP: `python3 tools/convert_regions.py` and
`python3 tools/convert_core.py` (the rest of `core/` is hand-ported).
Rebuilding the base patch: `python3 tools/make_base_patch.py <z3randomizer> data/base-patch.bin`.

## Debugging

In the browser console:

```js
AlttpBridge.status()             // mode: 'live' | 'snapshot' | 'idle'
AlttpBridge.peek(0x7EF340, 32)   // dump inventory bytes ($7EF340+)
```

## Known limits / next steps

- **snes9x core only.** The bridge parses snes9x's state format; bsnes would
  need its own parser (or a custom core build exporting `retro_get_memory_data`).
- **No Glitches only.** The in-app generator covers alttpr.com's No Glitches
  options; for glitched logic or entrance shuffle, generate elsewhere and use
  **Load ROM…**.
- **Changing ROMs reloads the page.** EmulatorJS can't swap games in place.
- Save files persist in the browser's IndexedDB (EmulatorJS default).

## Credits

- Tracker: [Hutch-ALTTPR Tracker](https://github.com/hutchch/ALTTPR-Tracker)
  by hutchch, MIT License (see `tracker/LICENSE`).
- Emulator: [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) (GPL-3.0),
  loaded from its CDN at runtime.
- Randomizer: ported from [alttp_vt_randomizer](https://github.com/sporchia/alttp_vt_randomizer)
  by sporchia (MIT); base patch built from [z3randomizer](https://github.com/KatDevsGames/z3randomizer)
  (MIT). See `randomizer/LICENSE-THIRD-PARTY.md`.
- No ROMs are included. Use your own legally obtained copy.

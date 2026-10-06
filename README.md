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

Open http://localhost:8080, click **Load ROM…**, and pick a seed `.sfc`.

To get a seed: generate one at https://alttpr.com/en/randomizer with your own
Japanese 1.0 ROM, download the patched file, and load that here. Set **World**
and **Dungeon items** in the top bar to match the seed.

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

## Debugging

In the browser console:

```js
AlttpBridge.status()             // mode: 'live' | 'snapshot' | 'idle'
AlttpBridge.peek(0x7EF340, 32)   // dump inventory bytes ($7EF340+)
```

## Known limits / next steps

- **snes9x core only.** The bridge parses snes9x's state format; bsnes would
  need its own parser (or a custom core build exporting `retro_get_memory_data`).
- **Seed generation is external.** Next step: call a randomizer API (or a
  self-hosted generator) and apply the patch client-side, so seeds are
  generated in-app.
- **Changing ROMs reloads the page.** EmulatorJS can't swap games in place.
- Save files persist in the browser's IndexedDB (EmulatorJS default).

## Credits

- Tracker: [Hutch-ALTTPR Tracker](https://github.com/hutchch/ALTTPR-Tracker)
  by hutchch, MIT License (see `tracker/LICENSE`).
- Emulator: [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) (GPL-3.0),
  loaded from its CDN at runtime.
- No ROMs are included. Use your own legally obtained copy.

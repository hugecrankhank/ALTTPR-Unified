const { app, BrowserWindow, ipcMain, globalShortcut, dialog } = require('electron');
const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const path = require('path');
const url  = require('url');
const fs   = require('fs');
const Store = require('electron-store');

const store = new Store();

// Single source of truth for the app version — Electron reads it from
// package.json, so bumping that file is the only place a release number needs
// to change. Everything that displays or compares a version uses this.
const APP_VERSION = app.getVersion();

// ── Single instance ──────────────────────────────────────────────────────────
// Prevent a second copy of the app from launching (which spawns duplicate
// windows and can race on the settings store). If another instance is already
// running, quit this one and focus the existing launcher instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (launcherWin && !launcherWin.isDestroyed()) {
      if (launcherWin.isMinimized()) launcherWin.restore();
      launcherWin.focus();
    } else {
      createLauncher();
    }
  });
}

let launcherWin   = null;
let itemWin       = null;
let mapWin        = null;
let timerWin      = null;
let broadcastWin      = null;
let checklistWin      = null;
let bcastSoundsWin    = null;
let bcastSettingsWin  = null;
let broadcastBg   = 'black';
let timerBg       = 'black';
let itemTrackerBg = 'black';

// ── Items REST API ──────────────────────────────────────────────────────────
// Read-only mirror of the ItemTracker's item state, exposed over HTTP so external
// tools (overlays, stream widgets) can poll individual item levels. The state is
// owned by the ItemTracker window; POST is accepted but ignored (read-only).
const API_CORE_ITEMS = [
  'bow', 'boomerang', 'hookshot', 'bomb', 'mushroom', 'powder', 'firerod', 'icerod',
  'bombos', 'ether', 'quake', 'lamp', 'hammer', 'shovel', 'flute', 'net', 'book',
  'bottle', 'somaria', 'byrna', 'cape', 'mirror', 'halfmagic', 'boots', 'gloves',
  'flippers', 'moonpearl', 'sword', 'shield', 'tunic', 'agahnim', 'crystals',
  'mmMedallion', 'trMedallion',
  // The tracker's own GO-mode toggle. Not an inventory item, but overlays want
  // it, and the WebSocket already carries it.
  'gomode',
];
// Max level per item (documentation metadata; 0..max). Defaults to 1 (on/off).
const API_ITEM_MAX = {
  sword: 4, shield: 3, tunic: 2, gloves: 2, bow: 3, boomerang: 3, bottle: 4,
  flute: 2, crystals: 7, mmMedallion: 3, trMedallion: 3,
};
const apiItemState = {};
API_CORE_ITEMS.forEach((k) => { apiItemState[k] = 0; });
// Dungeons exposed by the API (prize, chests, keys, boss state, etc.).
const API_DUNGEONS = ['ep', 'dp', 'toh', 'pod', 'sp', 'sw', 'tt', 'ip', 'mm', 'tr', 'gt'];
const API_DUNGEON_NAMES = {
  ep: 'Eastern Palace', dp: 'Desert Palace', toh: 'Tower of Hera', pod: 'Palace of Darkness',
  sp: 'Swamp Palace', sw: 'Skull Woods', tt: "Thieves' Town", ip: 'Ice Palace',
  mm: 'Misery Mire', tr: 'Turtle Rock', gt: "Ganon's Tower",
};
const apiDungeonState = {};
// Where Link is right now: a dungeon key, or null on the overworld / in a cave.
// Hyrule Castle and Agahnim's Tower have no /dungeons entry, so they are named
// here for /location.
let apiCurrentDungeon = null;
let apiCurrentFloor   = null;   // '1F', 'B1' … while in a dungeon
let apiCurrentWorld   = null;   // 'lw' | 'dw'
const API_LOCATION_NAMES = Object.assign({ hc: 'Hyrule Castle', ct: "Agahnim's Tower" }, API_DUNGEON_NAMES);
API_DUNGEONS.forEach((k) => { apiDungeonState[k] = { name: API_DUNGEON_NAMES[k] }; });
let apiServer     = null;
let apiServerInfo = { host: null, port: null };

function apiItemMax(item) { return API_ITEM_MAX[item] || 1; }

function buildOpenApiSpec(host, port) {
  const paths = {
    '/items': {
      get: {
        summary: 'Get all item levels',
        operationId: 'getItems',
        responses: {
          200: {
            description: 'Current level of every tracked item',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Items' } } },
          },
        },
      },
    },
  };
  // One explicit endpoint per item.
  API_CORE_ITEMS.forEach((item) => {
    paths['/items/' + item] = {
      get: {
        summary: 'Get ' + item + ' level',
        operationId: 'get_' + item,
        responses: {
          200: {
            description: item + ' level (0..' + apiItemMax(item) + ')',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
          },
        },
      },
      post: {
        summary: 'Ignored — item state is read-only (owned by the ItemTracker)',
        operationId: 'post_' + item,
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
        },
        responses: {
          200: {
            description: 'Accepted but ignored; returns the unchanged current value',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
          },
        },
      },
    };
  });
  paths['/location'] = {
    get: {
      summary: 'Get the dungeon the player is in right now',
      operationId: 'getLocation',
      responses: {
        200: {
          description: 'Current dungeon, or null on the overworld / in a cave',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Location' } } },
        },
      },
    },
  };
  // Dungeons: all + one explicit endpoint per dungeon.
  paths['/dungeons'] = {
    get: {
      summary: 'Get all dungeon states',
      operationId: 'getDungeons',
      responses: {
        200: {
          description: 'State of every dungeon',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Dungeons' } } },
        },
      },
    },
  };
  API_DUNGEONS.forEach((d) => {
    paths['/dungeons/' + d] = {
      get: {
        summary: 'Get ' + API_DUNGEON_NAMES[d] + ' state',
        operationId: 'get_dungeon_' + d,
        responses: {
          200: {
            description: API_DUNGEON_NAMES[d] + ' state',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Dungeon' } } },
          },
        },
      },
      post: {
        summary: 'Ignored — dungeon state is read-only (owned by the ItemTracker)',
        operationId: 'post_dungeon_' + d,
        responses: {
          200: {
            description: 'Accepted but ignored; returns the unchanged current state',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Dungeon' } } },
          },
        },
      },
    };
  });
  return {
    openapi: '3.0.3',
    info: {
      title: 'ALTTPR Tracker Items API',
      version: APP_VERSION,
      description: 'Read-only mirror of the item tracker. Each item has its own endpoint. '
                 + 'GET returns the current numeric level; POST is accepted but ignored.',
    },
    servers: [{ url: 'http://' + host + ':' + port }],
    paths,
    components: {
      schemas: {
        Item: {
          type: 'object',
          properties: {
            item:  { type: 'string' },
            value: { type: 'integer', minimum: 0 },
            max:   { type: 'integer' },
          },
          required: ['item', 'value'],
        },
        Items: {
          type: 'object',
          additionalProperties: { type: 'integer' },
        },
        Dungeon: {
          type: 'object',
          properties: {
            dungeon:       { type: 'string' },
            name:          { type: 'string' },
            prize:         { type: 'string', description: 'crystal | pendant | greenpendant | redcrystal | unknown' },
            prizeObtained: { type: 'boolean' },
            chests:        { type: 'integer', description: 'Unchecked chests remaining' },
            maxChests:     { type: 'integer' },
            smallKeys:     { type: 'integer' },
            maxSmallKeys:  { type: 'integer' },
            bigKey:        { type: 'integer' },
            map:           { type: 'integer' },
            compass:       { type: 'integer' },
            bossState:     { type: 'integer', description: '0 = unknown / vanilla boss' },
            bossOk:        { type: 'boolean' },
            inside:        { type: 'boolean', description: 'True while the player is in this dungeon' },
          },
        },
        Location: {
          type: 'object',
          properties: {
            dungeon: { type: 'string', nullable: true,
                       description: 'hc | ct | ep | dp | toh | pod | sp | sw | tt | ip | mm | tr | gt, or null on the overworld / in a cave' },
            name:    { type: 'string', nullable: true },
            floor:   { type: 'string', nullable: true, description: '1F, 2F … or B1, B2 … while in a dungeon' },
            world:   { type: 'string', nullable: true, description: 'lw (Light World) or dw (Dark World)' },
          },
        },
        Dungeons: {
          type: 'object',
          additionalProperties: { $ref: '#/components/schemas/Dungeon' },
        },
      },
    },
  };
}

function apiSend(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function apiHandleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') { apiSend(res, 204, {}); return; }

  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>ALTTPR Tracker Items API</title>'
      + '<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:24px;line-height:1.5}'
      + 'code{background:#222;padding:2px 6px;border-radius:4px}a{color:#4dff88}</style></head><body>'
      + '<h1>ALTTPR Tracker Items API</h1>'
      + '<p>Read-only mirror of the item tracker.</p><ul>'
      + '<li><a href="/items">/items</a> — all item levels</li>'
      + '<li><code>/items/{item}</code> — a single item, e.g. <a href="/items/sword">/items/sword</a></li>'
      + '<li><a href="/dungeons">/dungeons</a> — all dungeon states</li>'
      + '<li><code>/dungeons/{dungeon}</code> — a single dungeon, e.g. <a href="/dungeons/ip">/dungeons/ip</a></li>'
      + '<li><a href="/location">/location</a> — the dungeon the player is in right now (or null)</li>'
      + '<li><a href="/openapi.json">/openapi.json</a> — OpenAPI spec</li>'
      + '</ul></body></html>');
    return;
  }

  if (pathname === '/openapi.json' && req.method === 'GET') {
    apiSend(res, 200, buildOpenApiSpec(apiServerInfo.host, apiServerInfo.port));
    return;
  }

  if (pathname === '/items' && req.method === 'GET') {
    apiSend(res, 200, apiItemState);
    return;
  }

  const m = pathname.match(/^\/items\/([A-Za-z0-9_]+)$/);
  if (m) {
    const item = m[1];
    if (!Object.prototype.hasOwnProperty.call(apiItemState, item)) {
      apiSend(res, 404, { error: 'Unknown item', item });
      return;
    }
    if (req.method === 'GET') {
      apiSend(res, 200, { item, value: apiItemState[item], max: apiItemMax(item) });
      return;
    }
    if (req.method === 'POST') {
      // Read-only: accept but ignore the body, return the unchanged value.
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        apiSend(res, 200, {
          item, value: apiItemState[item], max: apiItemMax(item),
          readOnly: true,
          message: 'Ignored — item state is owned by the ItemTracker.',
        });
      });
      return;
    }
    apiSend(res, 405, { error: 'Method not allowed', item });
    return;
  }

  if (pathname === '/location' && req.method === 'GET') {
    apiSend(res, 200, { dungeon: apiCurrentDungeon,
                        name: apiCurrentDungeon ? (API_LOCATION_NAMES[apiCurrentDungeon] || apiCurrentDungeon) : null,
                        floor: apiCurrentDungeon ? apiCurrentFloor : null,
                        world: apiCurrentWorld });
    return;
  }

  // ── Dungeon map overlay ──
  // An OBS browser source: http://<host>:<port>/overlay/dungeon-map. It follows
  // tracker:location on the overlay WebSocket and shows the current dungeon's
  // map (Chris, Oct 2026). Served here rather than as a local file so OBS needs
  // no path into the app, and so the images can live outside it.
  if ((pathname === '/overlay/dungeon-map' || pathname === '/overlay/dungeon-map.html') && req.method === 'GET') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'overlays', 'dungeon-map.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch (e) { apiSend(res, 404, { error: 'Overlay missing' }); }
    return;
  }
  if (pathname === '/overlay/config' && req.method === 'GET') {
    apiSend(res, 200, { wsPort: wsServerInfo.port });
    return;
  }
  // Anything else under /overlay/ is a file beside the page — its maps/
  // folder above all. The page finds its images by relative path, so it works
  // the same opened from here or as a local file in OBS.
  if (pathname.indexOf('/overlay/') === 0 && req.method === 'GET') {
    const root = path.join(__dirname, 'overlays');
    const f = path.resolve(root, decodeURIComponent(pathname.slice('/overlay/'.length)));
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
                    '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
    const type = types[path.extname(f).toLowerCase()];
    if (type && f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(f));
    } else {
      apiSend(res, 404, { error: 'Not found', path: pathname });
    }
    return;
  }

  if (pathname === '/dungeons' && req.method === 'GET') {
    apiSend(res, 200, apiDungeonState);
    return;
  }

  const dm = pathname.match(/^\/dungeons\/([A-Za-z0-9_]+)$/);
  if (dm) {
    const dkey = dm[1];
    if (!Object.prototype.hasOwnProperty.call(apiDungeonState, dkey)) {
      apiSend(res, 404, { error: 'Unknown dungeon', dungeon: dkey });
      return;
    }
    if (req.method === 'GET') {
      apiSend(res, 200, Object.assign({ dungeon: dkey }, apiDungeonState[dkey]));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        apiSend(res, 200, Object.assign({ dungeon: dkey }, apiDungeonState[dkey], {
          readOnly: true,
          message: 'Ignored — dungeon state is owned by the ItemTracker.',
        }));
      });
      return;
    }
    apiSend(res, 405, { error: 'Method not allowed', dungeon: dkey });
    return;
  }

  apiSend(res, 404, { error: 'Not found', path: pathname });
}

function stopApiServer() {
  if (apiServer) {
    try { apiServer.close(); } catch (e) {}
    apiServer = null;
    apiServerInfo = { host: null, port: null };
  }
}

function startApiServer(host, port) {
  stopApiServer();
  apiServerInfo = { host, port };
  apiServer = http.createServer(apiHandleRequest);
  apiServer.on('error', (err) => {
    console.error('[items-api] server error:', err && err.message);
    apiServer = null;
    apiServerInfo = { host: null, port: null };
  });
  apiServer.listen(port, host, () => {
    console.log('[items-api] listening on http://' + host + ':' + port);
  });
}

// Start/stop the API server based on saved settings.
function applyApiSettings(settings) {
  const s = settings || store.get('settings', {}) || {};
  // Default on: a first run with nothing saved yet still serves the API, so an
  // overlay works out of the box. Only an explicit 'no' turns it off.
  const enabled = (s.apiEnabled === undefined || s.apiEnabled === null)
                  ? true
                  : (s.apiEnabled === 'yes' || s.apiEnabled === true);
  const host = (s.apiHost && String(s.apiHost).trim()) || '127.0.0.1';
  const port = parseInt(s.apiPort, 10) || 8720;
  const wsPort = parseInt(s.apiWsPort, 10) || 8201;
  if (!enabled) { stopApiServer(); stopWsServer(); return; }
  if (!(apiServer && apiServerInfo.host === host && apiServerInfo.port === port)) startApiServer(host, port);
  if (!(wsServer && wsServerInfo.host === host && wsServerInfo.port === wsPort)) startWsServer(host, wsPort);
}

// ── Overlay WebSocket broadcast server ────────────────────────────────────────
// Broadcasts the live tracker state in the HoellTracker overlay format
// ({ type, data } envelope) so overlays built against that API work here too.
// Read-only / broadcast-only: we accept connections, send a full-state snapshot,
// then push per-channel updates. Incoming messages are ignored.
let wsServer     = null;
let wsServerInfo = { host: null, port: null };
const wsClients   = new Set();
const wsChannels  = {}; // channel -> last data object (for full-state snapshot)
const wsLastJson  = {}; // channel -> last JSON string (change detection)
const wsPrevPrize = {}; // dungeonId -> last prizeType
const wsPrevMed   = {}; // 'mm'|'tr' -> last medallion name

function wsAccept(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function wsEncodeText(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsBroadcast(type, data) {
  if (!wsClients.size) return;
  const frame = wsEncodeText(JSON.stringify({ type, data }));
  for (const sock of wsClients) { try { sock.write(frame); } catch (e) {} }
}

function wsSetChannel(type, data) {
  wsChannels[type] = data;
  const json = JSON.stringify(data);
  if (wsLastJson[type] === json) return; // unchanged — don't spam
  wsLastJson[type] = json;
  wsBroadcast(type, data);
}

function wsFullState() {
  const out = {};
  Object.keys(wsChannels).forEach((k) => { out[k] = wsChannels[k]; });
  return out;
}

function wsBroadcastSeedReset() {
  // Clear caches so the next snapshot re-broadcasts a fresh state.
  Object.keys(wsChannels).forEach((k) => delete wsChannels[k]);
  Object.keys(wsLastJson).forEach((k) => delete wsLastJson[k]);
  Object.keys(wsPrevPrize).forEach((k) => delete wsPrevPrize[k]);
  Object.keys(wsPrevMed).forEach((k) => delete wsPrevMed[k]);
  wsBroadcast('tracker:seed-reset', {});
}

// ── Map this tracker's snapshot into the HoellTracker channel shapes ──────────
function wsPrizeType(p) {
  switch (p) {
    case 'greenpendant': return 'pendant_green';
    case 'pendant':      return 'pendant';
    case 'redcrystal':   return 'crystal56';
    case 'crystal':      return 'crystal';
    default:             return 'unknown';
  }
}
function wsMedName(v) { return v === 1 ? 'bombos' : v === 2 ? 'ether' : v === 3 ? 'quake' : 'unknown'; }

function wsBuildItems(snap) {
  const n = (v) => (typeof v === 'number' ? v : 0);
  const b = (v) => (typeof v === 'number' ? v > 0 : !!v);
  const flute = n(snap.flute);
  return {
    bow: n(snap.bow), boomerang: n(snap.boomerang), sword: n(snap.sword),
    shield: n(snap.shield),
    tunic: Math.min(3, n(snap.tunic) + 1),            // tracker 0=green → HoellTracker 1=green
    bottle: n(snap.bottle), glove: n(snap.gloves),
    flute: flute === 0 ? 0 : (flute >= 2 ? 3 : 2),    // 0 none, 2 have, 3 activated
    mushroom: n(snap.mushroom), arrowCount: 0,
    hookshot: b(snap.hookshot), bomb: b(snap.bomb), powder: b(snap.powder),
    bombos: b(snap.bombos), ether: b(snap.ether), quake: b(snap.quake),
    lantern: b(snap.lamp), hammer: b(snap.hammer), firerod: b(snap.firerod),
    icerod: b(snap.icerod), somaria: b(snap.somaria), byrna: b(snap.byrna),
    cape: b(snap.cape), mirror: b(snap.mirror), boots: b(snap.boots),
    flippers: b(snap.flippers), moonpearl: b(snap.moonpearl), net: b(snap.net),
    book: b(snap.book), shovel: b(snap.shovel), agahnim: b(snap.agahnim),
    // Not part of the HoellTracker channel shape, but the race overlay needs
    // them and they cost nothing: half magic, the crystal count, and the
    // tracker's own GO-mode toggle.
    halfmagic: b(snap.halfmagic), crystals: n(snap.crystals), gomode: b(snap.gomode),
    triforce: 0,
  };
}

function wsBuildDungeons(snap) {
  const n = (v) => (typeof v === 'number' ? v : 0);
  const out = {};
  API_DUNGEONS.forEach((k) => {
    out[k] = {
      chestsCollected: n(snap[k + 'Chests']),
      maxChests:       n(snap[k + 'MaxChests']),
      smallKeys:       n(snap[k + 'SmallKeys']),
      maxSmallKeys:    n(snap[k + 'MaxSmallKeys']),
      hasBigKey:       !!snap[k + 'BigKey'],
      bossDefeated:    !!snap[k + 'PrizeObtained'],
      hasCompass:      !!snap[k + 'Compass'],
      hasMap:          !!snap[k + 'Map'],
      prizeCollected:  !!snap[k + 'PrizeObtained'],
      prizeType:       wsPrizeType(snap[k + 'Prize']),
      inside:          snap.currentDungeon === k,
    };
  });
  return out;
}

function wsBuildMedallions(snap) {
  return { mm: wsMedName(snap.mmMedallion), tr: wsMedName(snap.trMedallion) };
}

// Called from the ItemTracker snapshot handler to push overlay updates.
function wsPushFromSnap(snap) {
  if (!wsServer) return;
  const dungeons = wsBuildDungeons(snap);
  const meds = wsBuildMedallions(snap);
  wsSetChannel('sni:item-update', wsBuildItems(snap));
  wsSetChannel('sni:dungeon-update', dungeons);
  wsSetChannel('tracker:medallions', meds);
  // Current location, as its own channel (null = overworld or a cave).
  const here = snap.currentDungeon || null;
  wsSetChannel('tracker:location', { dungeonId: here, name: here ? (API_LOCATION_NAMES[here] || here) : null,
                                     floor: here ? (snap.currentFloor || null) : null,
                                     world: snap.currentWorld || null });
  // Granular prize/medallion change events.
  API_DUNGEONS.forEach((k) => {
    const pt = dungeons[k].prizeType;
    const prev = wsPrevPrize[k] === undefined ? 'unknown' : wsPrevPrize[k];
    wsPrevPrize[k] = pt;
    if (prev !== pt) wsBroadcast('tracker:prize-change', { dungeonId: k, prizeType: pt });
  });
  ['mm', 'tr'].forEach((k) => {
    const prev = wsPrevMed[k] === undefined ? 'unknown' : wsPrevMed[k];
    wsPrevMed[k] = meds[k];
    if (prev !== meds[k]) wsBroadcast('tracker:medallion-change', { dungeonId: k, medallion: meds[k] });
  });
}

function stopWsServer() {
  for (const s of wsClients) { try { s.destroy(); } catch (e) {} }
  wsClients.clear();
  if (wsServer) { try { wsServer.close(); } catch (e) {} }
  wsServer = null;
  wsServerInfo = { host: null, port: null };
}

function startWsServer(host, port) {
  stopWsServer();
  wsServerInfo = { host, port };
  wsServer = http.createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade Required — connect to this endpoint via WebSocket.');
  });
  wsServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { try { socket.destroy(); } catch (e) {} return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
               + 'Upgrade: websocket\r\n'
               + 'Connection: Upgrade\r\n'
               + 'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
    wsClients.add(socket);
    const cleanup = () => wsClients.delete(socket);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('end', cleanup);
    // Broadcast-only: ignore inbound frames except a client close (opcode 0x8).
    socket.on('data', (buf) => {
      if (buf && buf.length && (buf[0] & 0x0f) === 0x8) { try { socket.destroy(); } catch (e) {} }
    });
    // Snapshot on connect.
    try { socket.write(wsEncodeText(JSON.stringify({ type: 'full-state', data: wsFullState() }))); } catch (e) {}
  });
  wsServer.on('error', (err) => {
    console.error('[overlay-ws] server error:', err && err.message);
    wsServer = null;
    wsServerInfo = { host: null, port: null };
  });
  wsServer.listen(port, host, () => {
    console.log('[overlay-ws] listening on ws://' + host + ':' + port);
  });
}

function findAppRoot() {
  const candidates = [
    __dirname,
    path.join(process.resourcesPath, 'app'),
    path.join(process.resourcesPath),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'items'))) {
      console.log('App root found:', dir);
      return dir;
    }
  }
  console.warn('Could not find items/ folder. Falling back to __dirname:', __dirname);
  return __dirname;
}

let APP_ROOT = null;

function getRoot() {
  if (!APP_ROOT) APP_ROOT = findAppRoot();
  return APP_ROOT;
}

function toFileUrl(rel) {
  return url.pathToFileURL(path.join(getRoot(), rel)).href;
}

// ── Launcher ──────────────────────────────────────────────────────────────────
function createLauncher() {
  launcherWin = new BrowserWindow({
    // The launcher body is 760px wide (two-column Settings, Timer beside
    // Display), plus the page's own 10px margins and a little slack.
    width: 800, height: 790,
    minWidth: 800, minHeight: 620,
    resizable: false,
    useContentSize: true,
    title: 'Hutch-ALTTPR Tracker',
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(getRoot(), 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    }
  });
  launcherWin.setMenuBarVisibility(false);
  // Cache-busted, for the same reason every renderer script carries ?v=NNNN:
  // Electron caches file:// pages across relaunches, so an edited index.html
  // can keep serving the previous copy — which looks exactly like a change
  // that didn't work (Chris, Sep 2026, chasing a seed-link fix that was
  // already in the file). The launcher is small; there is nothing to gain by
  // caching it. mtime rather than Date.now() so a rebuild is one entry, not
  // one per launch.
  var _idxV = APP_VERSION;
  try { _idxV = String(require('fs').statSync(path.join(getRoot(), 'index.html')).mtimeMs); }
  catch (e) {}
  launcherWin.loadURL(toFileUrl('index.html') + '?v=' + encodeURIComponent(_idxV));
  launcherWin.on('closed', () => {
    launcherWin = null;
    // Closing the launcher shuts down the whole app: close every other window
    // (item, map, timer, broadcast, checklist, bcast-sounds, bcast-settings) and stop servers.
    BrowserWindow.getAllWindows().forEach((w) => {
      if (w && !w.isDestroyed()) { try { w.close(); } catch (e) {} }
    });
    try { stopApiServer(); } catch (e) {}
    try { stopWsServer(); } catch (e) {}
    app.quit();
  });
}

// ── Item Tracker ──────────────────────────────────────────────────────────────
function createItemTrackerWindow(scale, wsHost, wsPort, bg, dungeonItems, bossShuffle, bounds) {
  const s = parseFloat(scale) || 1.0;
  const isTransparent = bg === 'transparent';
  const bgColors = { black: '#000000', white: '#ffffff', grey: '#2a2a2a', transparent: '#00000000' };
  const opts = {
    width:  (bounds && bounds.width)  || Math.ceil(460 * s),
    height: (bounds && bounds.height) || Math.ceil(600 * s),
    resizable: true,
    useContentSize: true,
    title: 'Item Tracker',
    backgroundColor: isTransparent ? undefined : (bgColors[bg] || '#000000'),
    transparent: isTransparent,
    titleBarStyle: isTransparent ? (process.platform === 'darwin' ? 'hiddenInset' : 'hidden') : 'default',
    titleBarOverlay: isTransparent && process.platform !== 'darwin' ? {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 30
    } : false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(getRoot(), 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    }
  };
  if (bounds && bounds.x !== undefined && bounds.y !== undefined) {
    opts.x = bounds.x;
    opts.y = bounds.y;
  }
  itemWin = new BrowserWindow(opts);
  itemWin.setMenuBarVisibility(false);
  const race = ((store.get('settings', {}) || {}).raceMode) || 'no';
  const pseudoboots = ((store.get('settings', {}) || {}).pseudoboots) || 'no';
  const mirrorscroll = ((store.get('settings', {}) || {}).mirrorscroll) || 'no';
  // Read from the store rather than a parameter so the recreate-on-bg-change
  // path below picks it up too. Retro raises every dungeon's chest count.
  const gamemode = ((store.get('settings', {}) || {}).gamemode) || 'standard';
  const universalKeys = ((store.get('settings', {}) || {}).universalKeys) || 'no';
  const keyDrop = ((store.get('settings', {}) || {}).keyDrop) || 'no';
  const enemyKeyDrop = ((store.get('settings', {}) || {}).enemyKeyDrop) || 'no';
  const keyDropAll = ((store.get('settings', {}) || {}).keyDropAll) || 'no';
  const potDrops = ((store.get('settings', {}) || {}).potDrops) || 'no';
  const enemyDrops = ((store.get('settings', {}) || {}).enemyDrops) || 'no';
  const potsBones = ((store.get('settings', {}) || {}).potsBones) || 'no';
  // Pottery Shuffle and the logic mode were the only seed flags never put on
  // the query string: both windows fell back to localStorage, and map.html's
  // own init sets trackerSettings.pottery to 'none' first, so anything reading
  // that saw 'none' and every cave pot vanished under Electron.
  const pottery = ((store.get('settings', {}) || {}).pottery) || 'none';
  const logicMode = ((store.get('settings', {}) || {}).logicMode) || 'noglitches';
  // The four dungeon-item shuffle flags (m/c/b/k). '' is a real value here
  // (nothing shuffled), so an absent setting is the only thing that falls back.
  const dungeonShuffle = ((store.get('settings', {}) || {}).dungeonShuffle) || '';
  const q = `?scale=${s}&wshost=${wsHost||'localhost'}&wsport=${wsPort||23074}&bg=${bg||'black'}&dungeonitems=${dungeonItems||'standard'}&dungeonshuffle=${dungeonShuffle}&bossshuffle=${bossShuffle||'yes'}&race=${race}&pseudoboots=${pseudoboots}&mirrorscroll=${mirrorscroll}&gamemode=${gamemode}&universalkeys=${universalKeys}&keydropall=${keyDropAll}&keydrop=${keyDrop}&enemykeydrop=${enemyKeyDrop}&potdrops=${potDrops}&enemydrops=${enemyDrops}&potsbones=${potsBones}&pottery=${pottery}&logic=${logicMode}`;
  itemWin.loadURL(toFileUrl('itemtracker.html') + q);
  itemWin.on('closed', () => { itemWin = null; });
  itemTrackerBg = bg || 'black';
}

function openItemTracker(scale, wsHost, wsPort, bg, dungeonItems, bossShuffle) {
  if (itemWin && !itemWin.isDestroyed()) { itemWin.focus(); return; }
  createItemTrackerWindow(scale, wsHost, wsPort, bg, dungeonItems, bossShuffle);
}

// ── Map ───────────────────────────────────────────────────────────────────────
function openMap(zoom, layout, enemizer, gtCrystals, wsHost, wsPort, gamemode, dungeonItems, swordless, bossShuffle, entranceShuffle, entranceMode) {
  if (mapWin && !mapWin.isDestroyed()) { mapWin.focus(); return; }
  const pct = parseInt(zoom) || 100;
  const size = Math.round(512 * pct / 100);
  const isVert = layout === 'vertical';
  // The same numbers map.html's resizeWindowToMap() arrives at — useContentSize
  // means these ARE content pixels, so the page has nothing left to correct.
  // They used to be a generous over-estimate (+360 tall), which is why the
  // window opened large and visibly shrank a few seconds later, once the page
  // had parsed and measured itself.
  mapWin = new BrowserWindow({
    // Must match map.html's resizeWindowToMap(): 10px of padding on every side,
    // a 12px gap between the two maps, and 63px of top and bottom bars.
    width:  isVert ? size + 20 : size * 2 + 32,
    height: isVert ? size * 2 + 12 + 83 : size + 83,
    resizable: true,
    show: false,              // …and nothing is shown until the first paint
    useContentSize: true,
    title: 'Map',
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(getRoot(), 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      // The map is often left visible while the user focuses on the game —
      // disable Chromium's background throttling so auto-tracker updates
      // keep painting at full speed even when this window isn't focused.
      backgroundThrottling: false,
    }
  });
  mapWin.setMenuBarVisibility(false);
  // Shown on the first paint, with a backstop so a page that never reports
  // ready-to-show can't leave the user with no window at all.
  const showMap = () => { if (mapWin && !mapWin.isDestroyed() && !mapWin.isVisible()) mapWin.show(); };
  // did-finish-load, not ready-to-show: the page resizes itself to the exact
  // map size while its scripts run, and ready-to-show fires before that — so
  // the window appeared at main's guess and then visibly shrank.
  mapWin.webContents.once('did-finish-load', showMap);
  mapWin.once('ready-to-show', () => setTimeout(showMap, 400));
  setTimeout(showMap, 3000);
  // Read from the store rather than adding another positional parameter to an
  // already long signature — same approach gamemode uses in the item tracker.
  const universalKeys = ((store.get('settings', {}) || {}).universalKeys) || 'no';
  const keyDrop = ((store.get('settings', {}) || {}).keyDrop) || 'no';
  const enemyKeyDrop = ((store.get('settings', {}) || {}).enemyKeyDrop) || 'no';
  const keyDropAll = ((store.get('settings', {}) || {}).keyDropAll) || 'no';
  const potDrops = ((store.get('settings', {}) || {}).potDrops) || 'no';
  const enemyDrops = ((store.get('settings', {}) || {}).enemyDrops) || 'no';
  const potsBones = ((store.get('settings', {}) || {}).potsBones) || 'no';
  // Pottery Shuffle and the logic mode were the only seed flags never put on
  // the query string: both windows fell back to localStorage, and map.html's
  // own init sets trackerSettings.pottery to 'none' first, so anything reading
  // that saw 'none' and every cave pot vanished under Electron.
  const pottery = ((store.get('settings', {}) || {}).pottery) || 'none';
  const logicMode = ((store.get('settings', {}) || {}).logicMode) || 'noglitches';
  const dungeonShuffle2 = ((store.get('settings', {}) || {}).dungeonShuffle) || '';
  const shopsanity = ((store.get('settings', {}) || {}).shopsanity) || 'no';
  const bonkShuffle = ((store.get('settings', {}) || {}).bonkShuffle) || 'no';
  const q = `?zoom=${pct}&layout=${layout||'horizontal'}&enemizer=${enemizer||'yes'}&gtcrystals=${gtCrystals||7}&wshost=${wsHost||'localhost'}&wsport=${wsPort||23074}&gamemode=${gamemode||'standard'}&dungeonitems=${dungeonItems||'standard'}&dungeonshuffle=${dungeonShuffle2}&swordless=${swordless||'no'}&universalkeys=${universalKeys}&keydropall=${keyDropAll}&keydrop=${keyDrop}&enemykeydrop=${enemyKeyDrop}&bossshuffle=${bossShuffle||'yes'}&entranceshuffle=${entranceShuffle||'no'}&entrancemode=${entranceMode||'none'}&shopsanity=${shopsanity}&bonkshuffle=${bonkShuffle}&potdrops=${potDrops}&enemydrops=${enemyDrops}&potsbones=${potsBones}&pottery=${pottery}&logic=${logicMode}`;
  mapWin.loadURL(toFileUrl('map.html') + q);
  mapWin.on('closed', () => { mapWin = null; });
}

// ── Timer window ──────────────────────────────────────────────────────────────
function createTimerWindow(wsHost, wsPort, color, bg, bounds) {
  const isTransparent = bg === 'transparent';
  const bgColors = { black: '#000000', white: '#ffffff', grey: '#2a2a2a', transparent: '#00000000' };
  const opts = {
    width:  (bounds && bounds.width)  || 370,
    height: (bounds && bounds.height) || 220,
    resizable: true,
    useContentSize: true,
    title: 'Timer',
    backgroundColor: isTransparent ? undefined : (bgColors[bg] || '#000000'),
    transparent: isTransparent,
    titleBarStyle: isTransparent ? (process.platform === 'darwin' ? 'hiddenInset' : 'hidden') : 'default',
    titleBarOverlay: isTransparent && process.platform !== 'darwin' ? {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 30
    } : false,
    hasShadow: true,
    webPreferences: {
      preload:          path.join(getRoot(), 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webSecurity:      false,
      // Critical: the timer's centisecond setInterval is clamped by Chromium
      // to ~1s when backgrounded. Without this the timer drifts massively
      // slow whenever the user focuses the game / OBS / another window.
      backgroundThrottling: false,
    }
  };
  if (bounds && bounds.x !== undefined && bounds.y !== undefined) {
    opts.x = bounds.x;
    opts.y = bounds.y;
  }
  timerWin = new BrowserWindow(opts);
  timerWin.setMenuBarVisibility(false);
  const q = `?wshost=${wsHost||'localhost'}&wsport=${wsPort||23074}&color=${color||'blue'}&bg=${bg||'black'}`;
  timerWin.loadURL(toFileUrl('timer.html') + q);
  timerWin.on('closed', () => { timerWin = null; });
  timerBg = bg || 'black';
}

function openTimer(wsHost, wsPort, color, bg) {
  if (timerWin && !timerWin.isDestroyed()) { timerWin.focus(); return; }
  createTimerWindow(wsHost, wsPort, color, bg);
}

// ── Broadcast window ──────────────────────────────────────────────────────────
function createBroadcastWindow(bg, bounds) {
  const root = getRoot();
  const isTransparent = bg === 'transparent';
  const bgColors = { black: '#000000', white: '#ffffff', grey: '#2a2a2a', transparent: '#00000000' };
  const opts = {
    width:  (bounds && bounds.width)  || 494,
    height: (bounds && bounds.height) || (process.platform === 'win32' ? 220 : 240),
    resizable: true,
    useContentSize: true,
    title: 'ALTTP Broadcast View',
    backgroundColor: isTransparent ? undefined : (bgColors[bg] || '#000000'),
    transparent: isTransparent,
    titleBarStyle: isTransparent ? (process.platform === 'darwin' ? 'hiddenInset' : 'hidden') : 'default',
    titleBarOverlay: isTransparent && process.platform !== 'darwin' ? {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 30
    } : false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      // Keep timers, BroadcastChannel callbacks, and paints running at full
      // speed even when the window is hidden behind OBS / the game window.
      // Without this, Chromium throttles backgrounded windows aggressively
      // and the broadcast view will stop updating until brought to focus.
      backgroundThrottling: false,
    },
  };
  if (bounds && bounds.x !== undefined && bounds.y !== undefined) {
    opts.x = bounds.x;
    opts.y = bounds.y;
  }
  broadcastWin = new BrowserWindow(opts);
  broadcastWin.setMenuBarVisibility(false);
  const broadcastFile   = path.join(root, 'broadcast.html');
  const appRootUrl = url.pathToFileURL(root).href;
  const race = ((store.get('settings', {}) || {}).raceMode) || 'no';
  broadcastWin.loadFile(broadcastFile, { query: { bg, approot: appRootUrl, race } });
  broadcastWin.on('closed', () => { broadcastWin = null; });
  broadcastBg = bg;
}

function openBroadcast(bg) {
  if (broadcastWin && !broadcastWin.isDestroyed()) { broadcastWin.focus(); return; }
  createBroadcastWindow(bg);
}

// ── Check List window ─────────────────────────────────────────────────────────
function openCheckList() {
  if (checklistWin && !checklistWin.isDestroyed()) { checklistWin.focus(); return; }
  checklistWin = new BrowserWindow({
    width: 350,
    height: 900,
    resizable: true,
    useContentSize: true,
    title: 'Check List',
    backgroundColor: '#111111',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(getRoot(), 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
    }
  });
  checklistWin.setMenuBarVisibility(false);
  checklistWin.loadURL(toFileUrl('checklist.html'));
  checklistWin.on('closed', () => { checklistWin = null; });
}

// ── IPC ───────────────────────────────────────────────────────────────────────
// ItemTracker pushes its latest item snapshot here; update the read-only mirror.
ipcMain.on('api-items-update', (event, snap) => {
  if (!snap || typeof snap !== 'object') return;
  API_CORE_ITEMS.forEach((k) => {
    if (typeof snap[k] === 'number') apiItemState[k] = snap[k];
  });
  const num = (v) => (typeof v === 'number' ? v : 0);
  API_DUNGEONS.forEach((k) => {
    apiDungeonState[k] = {
      name:          API_DUNGEON_NAMES[k],
      prize:         snap[k + 'Prize'] || 'unknown',
      prizeObtained: !!snap[k + 'PrizeObtained'],
      chests:        num(snap[k + 'Chests']),
      maxChests:     num(snap[k + 'MaxChests']),
      smallKeys:     num(snap[k + 'SmallKeys']),
      maxSmallKeys:  num(snap[k + 'MaxSmallKeys']),
      bigKey:        num(snap[k + 'BigKey']),
      map:           num(snap[k + 'Map']),
      compass:       num(snap[k + 'Compass']),
      bossState:     num(snap[k + 'BossState']),
      bossOk:        snap[k + 'BossOk'] !== false,
      inside:        snap.currentDungeon === k,
    };
  });
  if (snap.currentDungeon !== undefined) apiCurrentDungeon = snap.currentDungeon || null;
  if (snap.currentFloor   !== undefined) apiCurrentFloor   = snap.currentFloor   || null;
  if (snap.currentWorld   !== undefined) apiCurrentWorld   = snap.currentWorld   || null;
  // Push the same snapshot to the overlay WebSocket clients.
  wsPushFromSnap(snap);
});

// ItemTracker relays its SNI/autotracker connection status; re-broadcast it to
// overlays as the HoellTracker 'sni:connection-status' channel (cached, so it's
// also included in the full-state snapshot sent to newly connected overlays).
ipcMain.on('api-connection-status', (event, info) => {
  if (!info || typeof info !== 'object') return;
  wsSetChannel('sni:connection-status', {
    status:  info.status === 'connected' ? 'connected'
           : info.status === 'connecting' ? 'connecting' : 'disconnected',
    backend: info.backend || 'qusb2snes',
    detail:  info.detail || '',
  });
});

ipcMain.on('launch', (event, opts) => {
  // Merge into existing settings so a partial launch (e.g. opening the broadcast
  // view from the item tracker button) doesn't wipe the rest of the settings.
  const merged = Object.assign({}, store.get('settings', {}) || {}, opts);
  store.set('settings', merged);
  applyApiSettings(merged);
  if (opts.which === 'items' || opts.which === 'both') openItemTracker(opts.scale, opts.wsHost, opts.wsPort, opts.trackerBg, opts.dungeonItems, opts.bossshuffle);
  if (opts.which === 'map'   || opts.which === 'both') openMap(opts.zoom, opts.layout, opts.enemizer, opts.gtCrystals, opts.wsHost, opts.wsPort, opts.gamemode, opts.dungeonItems, opts.swordless, opts.bossshuffle, (opts.entranceShuffle && opts.entranceShuffle !== 'none') ? 'yes' : 'no', opts.entranceShuffle || 'none');
  if (opts.which === 'timer') openTimer(opts.wsHost, opts.wsPort, opts.timerColor, opts.timerBg);
  if (opts.which === 'broadcast') openBroadcast(opts.trackerBg || 'black');
  if (opts.which === 'checklist') openCheckList();
});

ipcMain.on('open-checklist', () => openCheckList());

ipcMain.handle('load-settings', () => store.get('settings', {}));

// Persist a broadcast background image to disk (userData) and return a file://
// URL. Lets large images / animated GIFs be used as the view background without
// hitting localStorage's data-URL size cap. Only one is kept at a time.
const _BCAST_BG_EXTS = ['gif','png','jpg','webp','bmp','img'];
ipcMain.handle('save-bcast-bg-image', (event, dataUrl) => {
  try {
    const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl || '');
    if (!m) return null;
    const extByMime = { 'image/gif':'gif','image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/bmp':'bmp' };
    const ext = extByMime[m[1]] || 'img';
    const dir = app.getPath('userData');
    _BCAST_BG_EXTS.forEach((e) => { try { fs.unlinkSync(path.join(dir, 'broadcast-bg.' + e)); } catch (_) {} });
    const file = path.join(dir, 'broadcast-bg.' + ext);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    return url.pathToFileURL(file).href;
  } catch (e) { console.error('[bcast-bg] save failed:', e && e.message); return null; }
});
ipcMain.handle('clear-bcast-bg-image', () => {
  try {
    const dir = app.getPath('userData');
    _BCAST_BG_EXTS.forEach((e) => { try { fs.unlinkSync(path.join(dir, 'broadcast-bg.' + e)); } catch (_) {} });
  } catch (e) {}
  return true;
});


ipcMain.handle('get-paths', () => {
  const root = getRoot();
  return {
    root,
    itemsUrl:    url.pathToFileURL(path.join(root, 'items')).href,
    mapUrl:      url.pathToFileURL(path.join(root, 'map')).href,
    itemsExists: fs.existsSync(path.join(root, 'items')),
  };
});

ipcMain.handle('set-broadcast-bg', (event, bg) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  // Only the broadcast window participates in this handler.
  if (broadcastWin !== win) return;

  const wasTransparent  = broadcastBg === 'transparent';
  const willBeTransparent = bg === 'transparent';

  // Electron does not allow toggling the `transparent` flag after a window is
  // created. To switch in or out of transparent mode we need to recreate the
  // window, preserving its current bounds so the user does not lose position.
  if (wasTransparent !== willBeTransparent) {
    const bounds = win.getBounds();
    setImmediate(() => {
      if (broadcastWin === win) broadcastWin = null;
      if (!win.isDestroyed()) win.close();
      createBroadcastWindow(bg, bounds);
    });
    return;
  }

  // Same transparency mode — just swap the solid background color.
  const bgColors = { black: '#000000', white: '#ffffff', grey: '#2a2a2a', image: '#000000' };
  if (bgColors[bg]) win.setBackgroundColor(bgColors[bg]);
  broadcastBg = bg;
});

ipcMain.handle('set-timer-bg', (event, bg) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || timerWin !== win) return;

  const wasTransparent  = timerBg === 'transparent';
  const willBeTransparent = bg === 'transparent';

  // Toggling transparency requires a window recreate (Electron limitation).
  if (wasTransparent !== willBeTransparent) {
    const bounds = win.getBounds();
    // Pull current ws/color from the window URL so the recreate matches.
    const currentUrl = new URL(win.webContents.getURL());
    const wsHost = currentUrl.searchParams.get('wshost') || 'localhost';
    const wsPort = currentUrl.searchParams.get('wsport') || '23074';
    const color  = currentUrl.searchParams.get('color')  || 'blue';
    setImmediate(() => {
      if (timerWin === win) timerWin = null;
      if (!win.isDestroyed()) win.close();
      createTimerWindow(wsHost, wsPort, color, bg, bounds);
    });
    return;
  }

  // Same transparency mode — just swap the solid background color.
  const bgColors = { black: '#000000', white: '#ffffff', grey: '#2a2a2a', custom: '#000000' };
  if (bgColors[bg]) win.setBackgroundColor(bgColors[bg]);
  timerBg = bg;
});

ipcMain.handle('set-itemtracker-bg', (event, bg) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || itemWin !== win) return;

  const wasTransparent    = itemTrackerBg === 'transparent';
  const willBeTransparent = bg === 'transparent';

  // Toggling transparency requires a window recreate (Electron limitation).
  if (wasTransparent !== willBeTransparent) {
    const bounds = win.getBounds();
    // Pull scale / ws / dungeonItems from the window URL so the recreate matches.
    const currentUrl   = new URL(win.webContents.getURL());
    const scale        = currentUrl.searchParams.get('scale')        || '1';
    const wsHost       = currentUrl.searchParams.get('wshost')       || 'localhost';
    const wsPort       = currentUrl.searchParams.get('wsport')       || '23074';
    const dungeonItems = currentUrl.searchParams.get('dungeonitems') || 'standard';
    const bossShuffle  = currentUrl.searchParams.get('bossshuffle')  || 'yes';
    setImmediate(() => {
      if (itemWin === win) itemWin = null;
      if (!win.isDestroyed()) win.close();
      createItemTrackerWindow(scale, wsHost, wsPort, bg, dungeonItems, bossShuffle, bounds);
    });
    return;
  }

  // Same transparency mode — just swap the solid background color.
  // 'image' keeps a black native window colour; the renderer paints the image.
  const bgColors = { black: '#000000', white: '#ffffff', grey: '#2a2a2a', image: '#000000' };
  if (bgColors[bg]) win.setBackgroundColor(bgColors[bg]);
  itemTrackerBg = bg;
});

// ── Update checker (notification-only, no auto-download) ─────────────────────
const CURRENT_VERSION = APP_VERSION;
const RELEASES_URL    = 'https://github.com/hutchch/ALTTPR-Tracker/releases';
const API_URL         = 'https://api.github.com/repos/hutchch/ALTTPR-Tracker/releases/latest';

function sendUpdateStatus(status, info) {
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('update-status', { status, info: info || null });
  }
}

function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function fetchLatestRelease(callback) {
  const opts = {
    hostname: 'api.github.com',
    path:     '/repos/hutchch/ALTTPR-Tracker/releases/latest',
    headers:  { 'User-Agent': 'ALTTPR-Tracker-Updater' },
    timeout:  8000,
  };
  const req = https.get(opts, (res) => {
    if (res.statusCode !== 200) { callback(null); return; }
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        callback(json.tag_name || null);  // e.g. "v1.1.14"
      } catch(e) { callback(null); }
    });
  });
  req.on('error',   () => callback(null));
  req.on('timeout', () => { req.destroy(); callback(null); });
}

function checkForUpdates() {
  sendUpdateStatus('checking');
  fetchLatestRelease((tagName) => {
    if (!tagName) {
      // No response — network down, API unavailable, etc. Stay quiet.
      sendUpdateStatus('up-to-date');
      return;
    }
    if (compareVersions(tagName, CURRENT_VERSION) > 0) {
      sendUpdateStatus('available', { version: tagName.replace(/^v/, ''), url: RELEASES_URL });
    } else {
      sendUpdateStatus('up-to-date');
    }
  });
}

function openBcastSoundsWindow() {
  if (bcastSoundsWin && !bcastSoundsWin.isDestroyed()) { bcastSoundsWin.focus(); return; }
  const root = getRoot();
  bcastSoundsWin = new BrowserWindow({
    width: 480, height: 620, resizable: true, useContentSize: true,
    title: 'Broadcast Item Sounds', backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
    },
  });
  bcastSoundsWin.setMenuBarVisibility(false);
  bcastSoundsWin.loadFile(path.join(root, 'bcast-sounds.html'));
  bcastSoundsWin.on('closed', () => { bcastSoundsWin = null; });
}
ipcMain.handle('open-bcast-sounds', () => openBcastSoundsWindow());

function openBcastSettingsWindow() {
  if (bcastSettingsWin && !bcastSettingsWin.isDestroyed()) { bcastSettingsWin.focus(); return; }
  const root = getRoot();
  bcastSettingsWin = new BrowserWindow({
    width: 440, height: 820, minWidth: 360, minHeight: 400, resizable: true, useContentSize: true,
    title: 'Broadcast Settings', backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
    },
  });
  bcastSettingsWin.setMenuBarVisibility(false);
  bcastSettingsWin.loadFile(path.join(root, 'bcast-settings.html'));
  bcastSettingsWin.on('closed', () => { bcastSettingsWin = null; });
}
ipcMain.handle('open-bcast-settings', () => openBcastSettingsWindow());

ipcMain.handle('check-for-updates', () => checkForUpdates());
// Lets the launcher render the real version instead of a hardcoded string.
ipcMain.handle('get-app-version', () => APP_VERSION);
ipcMain.handle('install-update', () => {
  const { shell } = require('electron');
  shell.openExternal(RELEASES_URL);
});

// ── Apply Patch ─────────────────────────────────────────────────────────────
// A .trkpatch is JSON: { format: 1, base, target, files: { "rel/path": base64 },
// delete: ["rel/path"] }, built by tools/make-patch.js from two version
// folders. The app ships its files unpacked (asar is off), so a patch only has
// to replace them in the app folder. Every file it touches is backed up first
// to _patch_backup/<time>/, and a failure part-way restores them (Chris, Oct
// 2026: a way to test changes without a full download).
const PATCH_ROOT = __dirname;   // Resources/app when packaged — where main.js and the pages live
function patchPath(rel) {
  const p = path.resolve(PATCH_ROOT, String(rel));
  if (!p.startsWith(PATCH_ROOT + path.sep)) throw new Error('Unsafe path in patch: ' + rel);
  return p;
}
ipcMain.handle('apply-patch', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const pick = await dialog.showOpenDialog(win, {
    title: 'Apply Patch', properties: ['openFile'],
    filters: [{ name: 'Tracker patch', extensions: ['trkpatch'] }]
  });
  if (pick.canceled || !pick.filePaths.length) return { ok: false, canceled: true };

  let patch;
  try { patch = JSON.parse(fs.readFileSync(pick.filePaths[0], 'utf8')); }
  catch (e) { return { ok: false, error: 'That is not a tracker patch file.' }; }
  if (!patch || patch.format !== 1 || !patch.files || typeof patch.files !== 'object') {
    return { ok: false, error: 'That is not a tracker patch file.' };
  }
  const allNames = Object.keys(patch.files);
  const allDels  = Array.isArray(patch.delete) ? patch.delete : [];
  try { allNames.concat(allDels).forEach(patchPath); } catch (e) { return { ok: false, error: e.message }; }
  // The patch holds what changed between the two folders it was built from;
  // compare it with what is installed here and only touch files that actually
  // differ — re-applying a patch, or applying it to a build that already has
  // it, changes nothing (Chris, Oct 2026).
  const names = allNames.filter(function (rel) {
    try { return !fs.readFileSync(patchPath(rel)).equals(Buffer.from(patch.files[rel], 'base64')); }
    catch (e) { return true; }   // missing here → it's new
  });
  const dels = allDels.filter(function (rel) { return fs.existsSync(patchPath(rel)); });
  if (!names.length && !dels.length) {
    await dialog.showMessageBox(win, {
      type: 'info', buttons: ['OK'],
      message: 'Already up to date — every file in this patch matches what is installed.'
    });
    return { ok: true, count: 0, upToDate: true };
  }

  if (patch.base && patch.base !== APP_VERSION) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'Apply anyway'], defaultId: 0, cancelId: 0,
      message: 'This patch is for version ' + patch.base + '.',
      detail: 'This tracker is version ' + APP_VERSION + '. Applying it to a different version can leave the files out of step.'
    });
    if (r.response !== 1) return { ok: false, canceled: true };
  }

  const backup = path.join(PATCH_ROOT, '_patch_backup', new Date().toISOString().replace(/[:.]/g, '-'));
  const existed = {};
  const done = [];
  try {
    for (const rel of names.concat(dels)) {
      const p = patchPath(rel);
      existed[rel] = fs.existsSync(p);
      if (existed[rel]) {
        const b = path.join(backup, rel);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(p, b);
      }
    }
    for (const rel of names) {
      const p = patchPath(rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(patch.files[rel], 'base64'));
      done.push(rel);
    }
    for (const rel of dels) {
      const p = patchPath(rel);
      if (fs.existsSync(p)) { fs.unlinkSync(p); done.push(rel); }
    }
  } catch (e) {
    // Put back what was already changed, so a half-applied patch can't leave
    // the app mixing two versions.
    for (const rel of done) {
      try {
        const p = patchPath(rel);
        if (existed[rel]) fs.copyFileSync(path.join(backup, rel), p);
        else if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {}
    }
    const perm = e.code === 'EACCES' || e.code === 'EPERM';
    return { ok: false, error: perm
      ? 'No permission to write to the app folder (' + PATCH_ROOT + '). On Windows, run the tracker as administrator once to apply the patch.'
      : 'Patch failed and was rolled back: ' + e.message };
  }

  // Keep only the three newest backups (Chris, Oct 2026). The folder names
  // are ISO timestamps, so they sort oldest-first as plain strings.
  try {
    const root = path.join(PATCH_ROOT, '_patch_backup');
    const sets = fs.readdirSync(root, { withFileTypes: true })
      .filter(function (d) { return d.isDirectory(); })
      .map(function (d) { return d.name; }).sort();
    sets.slice(0, Math.max(0, sets.length - 3)).forEach(function (n) {
      fs.rmSync(path.join(root, n), { recursive: true, force: true });
    });
  } catch (_) {}   // pruning is housekeeping — never fail a good patch over it

  const r = await dialog.showMessageBox(win, {
    type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
    message: 'Patch applied — ' + names.length + ' file' + (names.length === 1 ? '' : 's') + ' updated' +
             (dels.length ? ', ' + dels.length + ' removed' : '') + '.',
    detail: (patch.target ? 'Version ' + patch.target + '. ' : '') +
            'Restart the tracker to load it. The replaced files are backed up in ' + backup + '.'
  });
  if (r.response === 0) { app.relaunch(); app.exit(0); }
  return { ok: true, count: names.length, target: patch.target || '' };
});

ipcMain.handle('open-external', (event, url) => {
  const { shell } = require('electron');
  // Only allow http/https URLs to be opened this way.
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

// ── New Game global hotkey ────────────────────────────────────────────────────
let newgameHotkey = null; // currently registered accelerator string, or null

function fireNewgame() {
  // Send only to itemtracker — resetItemTracker() will BroadcastChannel
  // the newgame event to map and broadcast windows itself.
  if (itemWin && !itemWin.isDestroyed()) {
    itemWin.webContents.send('newgame');
  }
  // Tell overlay clients to clear their state for the new seed.
  wsBroadcastSeedReset();
}

ipcMain.handle('register-newgame-hotkey', (event, accelerator) => {
  // Unregister any existing hotkey first
  if (newgameHotkey) {
    globalShortcut.unregister(newgameHotkey);
    newgameHotkey = null;
  }
  try {
    const ok = globalShortcut.register(accelerator, fireNewgame);
    if (ok) { newgameHotkey = accelerator; return { ok: true }; }
    return { ok: false, error: 'Accelerator already in use or invalid' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('unregister-newgame-hotkey', () => {
  if (newgameHotkey) {
    globalShortcut.unregister(newgameHotkey);
    newgameHotkey = null;
  }
  return { ok: true };
});

// ── Entrance state save / load ────────────────────────────────────────────────
ipcMain.handle('save-ent-state', async (event, json) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: 'Save Entrance State',
    defaultPath: 'alttp-entrance-state.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, json, 'utf8');
  return { ok: true };
});

ipcMain.handle('load-ent-state', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    title: 'Load Entrance State',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false };
  const json = fs.readFileSync(filePaths[0], 'utf8');
  return { ok: true, json };
});

// Clean up on quit
app.on('will-quit', () => { globalShortcut.unregisterAll(); });

// ── Plugin host ───────────────────────────────────────────────────────────────
// Optional drop-in plugins live in <appRoot>/plugins/<name>/ with a plugin.json
// manifest and a main module exporting activate(ctx). Plugins are NOT bundled in
// the tracker build — they are installed separately on top of an installed
// tracker. Because a plugin window runs inside this app, it shares the
// 'alttp-tracker' BroadcastChannel with the item/map windows and can read the
// tracker's own items/ folder (passed as ctx.itemsUrl) — no duplication.
function loadPlugins() {
  const dir = path.join(getRoot(), 'plugins');
  if (!fs.existsSync(dir)) return;   // no plugins installed — nothing to do

  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { console.warn('[plugin] cannot read plugins dir:', e.message); return; }

  const settings = store.get('settings', {}) || {};
  const itemsUrl = url.pathToFileURL(path.join(getRoot(), 'items')).href + '/';

  for (const name of names) {
    const pdir = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(pdir); } catch (e) { continue; }
    if (!stat.isDirectory()) continue;

    const manifestPath = path.join(pdir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) { console.warn('[plugin] bad manifest in', name, '-', e.message); continue; }

    if (manifest.autoOpen === false) { console.log('[plugin] skipping (autoOpen:false):', name); continue; }

    const modPath = path.join(pdir, manifest.main || 'plugin-main.js');
    if (!fs.existsSync(modPath)) { console.warn('[plugin] missing main module for', name); continue; }

    try {
      const mod = require(modPath);
      if (typeof mod.activate !== 'function') { console.warn('[plugin] no activate() in', name); continue; }
      mod.activate({
        pluginDir: pdir,
        manifest,
        appRoot:   getRoot(),
        itemsUrl,
        wsHost:    settings.wsHost || 'localhost',
        wsPort:    settings.wsPort || 23074,
      });
      console.log('[plugin] activated:', manifest.name || name);
    } catch (e) {
      console.error('[plugin] activation failed for', name, '-', e);
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  console.log('__dirname        :', __dirname);
  console.log('resourcesPath    :', process.resourcesPath);
  console.log('appRoot          :', getRoot());
  createLauncher();
  loadPlugins();
  applyApiSettings();
  // Check for updates a few seconds after launch so the window is ready
  setTimeout(() => checkForUpdates(), 3000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLauncher();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

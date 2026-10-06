// Randomizer bar: settings dropdowns -> seed generation (in a worker) ->
// patch the player's own Japanese 1.0 ROM in the browser -> boot it.
import { md5 } from './md5.js';

const JP10_MD5 = '03a63945398191337e896e5771f77173';   // ALttP (Japan) v1.0, headerless
const BASE_MD5 = 'edc01f3db798ae4dfe21101311598d44';   // after the 2024-02-18 base patch (alttpr.com build)
const ROM_SIZE = 0x200000;
const $ = (id) => document.getElementById(id);

// ── tiny IndexedDB key/value store (ROMs never leave the device) ──────────────
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('alttpr-unified', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kvSet(key, val) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function kvDel(key) {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
export { kvGet, kvSet, kvDel };

// ── settings ─────────────────────────────────────────────────────────────────
const FIELDS = ['r-mode', 'r-goal', 'r-tower', 'r-ganon', 'r-weapons', 'r-placement', 'r-dungeon', 'r-access',
  'r-pool', 'r-func', 'r-hints', 'r-heartbeep', 'r-quickswap', 'r-menuspeed'];

function readSettings() {
  return {
    mode: $('r-mode').value,
    goal: $('r-goal').value,
    crystals: { tower: $('r-tower').value, ganon: $('r-ganon').value },
    weapons: $('r-weapons').value,
    item_placement: $('r-placement').value,
    dungeon_items: $('r-dungeon').value,
    accessibility: $('r-access').value,
    item: { pool: $('r-pool').value, functionality: $('r-func').value },
    hints: $('r-hints').value,
  };
}

function saveFields() {
  const o = {};
  FIELDS.forEach((id) => { if ($(id)) o[id] = $(id).value; });
  try { localStorage.setItem('rando-settings', JSON.stringify(o)); } catch (e) {}
}

function loadFields() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem('rando-settings') || '{}'); } catch (e) {}
  FIELDS.forEach((id) => {
    const el = $(id);
    if (el && o[id] != null && [...el.options].some((op) => op.value === o[id])) el.value = o[id];
  });
}

// ── base ROM ─────────────────────────────────────────────────────────────────
function stripHeader(bytes) {
  return bytes.length % 1024 === 512 ? bytes.subarray(512) : bytes;
}

async function setBaseRom(file) {
  let bytes = stripHeader(new Uint8Array(await file.arrayBuffer()));
  if (bytes.length > 0x100000) bytes = bytes.subarray(0, 0x100000);
  const sum = md5(bytes);
  if (sum !== JP10_MD5) {
    throw new Error('That file isn\'t a Japanese 1.0 "Zelda no Densetsu: Kamigami no Triforce" ROM '
      + '(the one alttpr.com uses). MD5 ' + sum);
  }
  await kvSet('base-jp10', bytes.slice());
  return true;
}

let basePatchCache = null;
async function loadBasePatch() {
  if (basePatchCache) return basePatchCache;
  const res = await fetch(new URL('data/base-patch.bin', import.meta.url));
  if (!res.ok) throw new Error('Could not load the base patch (' + res.status + ')');
  basePatchCache = new Uint8Array(await res.arrayBuffer());
  return basePatchCache;
}

async function buildBaseRom() {
  const jp = await kvGet('base-jp10');
  if (!jp) throw new Error('Choose your Japanese 1.0 ROM first (Base ROM button).');
  const rom = new Uint8Array(ROM_SIZE);
  rom.set(jp.subarray(0, 0x100000));
  const p = await loadBasePatch();
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  if (String.fromCharCode(p[0], p[1], p[2], p[3]) !== 'Z3BP') throw new Error('Corrupt base patch file');
  const n = dv.getUint32(4, true);
  let o = 8;
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(o, true), len = dv.getUint32(o + 4, true);
    o += 8;
    rom.set(p.subarray(o, o + len), off);
    o += len;
  }
  // Should match alttpr.com's own base ROM exactly. If it ever doesn't, still
  // play (the seed data is the same) but say so.
  const sum = md5(rom);
  if (sum !== BASE_MD5) console.warn('[randomizer] base ROM MD5 ' + sum + ' differs from alttpr.com build ' + BASE_MD5);
  return { rom, baseOk: sum === BASE_MD5 };
}

function applyCosmetics(rom) {
  const w = (off, ...b) => b.forEach((v, i) => { rom[off + i] = v; });
  const beep = { off: 0x00, half: 0x40, quarter: 0x80, double: 0x10, normal: 0x20 }[$('r-heartbeep').value] ?? 0x40;
  w(0x180033, beep);
  w(0x18004B, $('r-quickswap').value === 'on' ? 0x01 : 0x00);
  const ms = $('r-menuspeed').value;
  w(0x180048, { instant: 0xE8, fast: 0x10, normal: 0x08, slow: 0x04 }[ms] ?? 0x08);
  const fast = ms === 'instant';
  w(0x6DD9A, fast ? 0x20 : 0x11);
  w(0x6DF2A, fast ? 0x20 : 0x12);
  w(0x6E0E9, fast ? 0x20 : 0x12);
  w(0x18021A, 0x00);   // music on
  w(0x18017F, 0x00);   // reduce flashing off
}

function updateChecksum(rom) {
  let sum = 0;
  for (let i = 0; i < rom.length; i++) if (i < 0x7FDC || i >= 0x7FE0) sum += rom[i];
  const checksum = (sum + 0x1FE) & 0xFFFF;
  const inverse = checksum ^ 0xFFFF;
  rom[0x7FDC] = inverse & 0xFF; rom[0x7FDD] = inverse >> 8;
  rom[0x7FDE] = checksum & 0xFF; rom[0x7FDF] = checksum >> 8;
}

// ── generation in a worker ────────────────────────────────────────────────────
let worker = null, reqId = 0;
const pending = new Map();
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Generator failed to load'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}
function runGenerator(settings, seed) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, settings, seed, stamp: true });
  });
}

function randomSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] >>> 0;
}

function parseSeed(text) {
  text = String(text || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(BigInt(text) % 4294967296n);
  // any other text: hash it into a seed so "words" work too
  let h = 2166136261;
  for (const c of new TextEncoder().encode(text)) { h ^= c; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// ── UI ───────────────────────────────────────────────────────────────────────
let last = null;   // { rom, name, spoiler }

function status(msg, kind = '') {
  const el = $('r-status');
  el.textContent = msg;
  el.className = kind;
}

async function refreshBaseStatus() {
  const has = !!(await kvGet('base-jp10').catch(() => null));
  $('r-base-label').textContent = has ? 'Base ROM ✓' : 'Base ROM…';
  $('r-base-label').classList.toggle('ok', has);
  $('r-base-label').title = has
    ? 'Your Japanese 1.0 ROM is saved in this browser. Click to replace it.'
    : 'Choose your Japanese 1.0 ALttP ROM (stays on this device)';
  return has;
}

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function showLast() {
  $('r-download').hidden = !last;
  $('r-spoiler').hidden = !last;
  $('r-seed-out').textContent = last ? `Seed ${last.spoiler.seed}` : '';
  $('r-seed-out').title = 'Type this number in the seed box to get the same game again';
}

const TRACKER_DI = { standard: 'standard', mc: 'mapcompass', mcs: 'mapcompasskeys', full: 'keysanity' };

async function generateAndPlay() {
  const btn = $('r-generate');
  if (btn.disabled) return;
  if (!(await refreshBaseStatus())) {
    status('First choose your Japanese 1.0 ROM with the Base ROM button.', 'bad');
    $('r-base-input').click();
    return;
  }
  saveFields();
  const settings = readSettings();
  const typed = parseSeed($('r-seed').value);
  btn.disabled = true;
  try {
    status('Patching base ROM…');
    const { rom: base, baseOk } = await buildBaseRom();
    let res = null, tries = 0, seed = typed ?? randomSeed();
    for (;;) {
      tries++;
      status(tries === 1 ? 'Generating seed…' : `Generating seed (attempt ${tries})…`);
      try {
        res = await runGenerator(settings, seed);
        if (res.winnable) break;
        throw new Error('the finished game wasn\'t beatable');
      } catch (e) {
        // the official generator also gives up on some seeds (alttpr.com just
        // asks you to try again); for random seeds we quietly roll a new one
        if (typed !== null) throw new Error(`Seed ${seed} doesn't work with these settings (${e.message}). Try another number, or clear the seed box for a random one.`);
        if (tries >= 8) throw e;
      }
      seed = randomSeed();
    }
    const rom = base;
    for (const w of res.patch) for (const [off, bytes] of Object.entries(w)) rom.set(bytes, Number(off));
    applyCosmetics(rom);
    updateChecksum(rom);

    const m = res.spoiler.meta || {};
    const name = `alttpr - ${m.logic}-${m.mode}-${m.goal}_${res.hash}.sfc`;
    last = { rom, name, spoiler: { seed: res.seed, hash: res.hash, ...res.spoiler } };
    showLast();
    status(baseOk ? `Ready: ${res.hash} (${(res.ms / 1000).toFixed(1)}s)`
      : `Ready: ${res.hash}. Note: the base ROM check didn't match alttpr.com's build; report it if anything looks off.`, baseOk ? 'ok' : 'bad');
    // on phones, fold the settings away so the game is on screen
    if (window.innerWidth <= 900) {
      document.body.classList.remove('rando-open');
      $('r-toggle').setAttribute('aria-expanded', 'false');
    }
    // keep it across the page reload EmulatorJS needs when switching games
    try { await kvSet('last-seed', last); } catch (e) {}

    window.UnifiedApp.playRom(rom, name, {
      gamemode: settings.mode,
      dungeonitems: TRACKER_DI[settings.dungeon_items] || 'standard',
      swordless: settings.weapons === 'swordless' ? 'yes' : 'no',
      gtcrystals: String(m.crystals_tower ?? 7),
    });
  } catch (e) {
    console.error(e);
    status(String(e.message || e), 'bad');
  } finally {
    btn.disabled = false;
  }
}

export function init() {
  loadFields();
  FIELDS.forEach((id) => $(id) && $(id).addEventListener('change', saveFields));
  $('r-base-input').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      await setBaseRom(f);
      status('Base ROM saved. Pick your settings and press Generate.', 'ok');
    } catch (e) {
      status(String(e.message || e), 'bad');
    }
    refreshBaseStatus();
  });
  $('r-generate').addEventListener('click', generateAndPlay);
  $('r-download').addEventListener('click', () => last && download(last.rom, last.name, 'application/octet-stream'));
  $('r-spoiler').addEventListener('click', () => last && download(
    new TextEncoder().encode(JSON.stringify(last.spoiler, null, 2)), last.name.replace(/\.sfc$/, '') + '_spoiler.json', 'application/json'));
  $('r-toggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('rando-open');
    $('r-toggle').setAttribute('aria-expanded', String(open));
    try { localStorage.setItem('rando-open', open ? '1' : '0'); } catch (e) {}
  });
  let open = true;
  try { open = localStorage.getItem('rando-open') !== '0'; } catch (e) {}
  document.body.classList.toggle('rando-open', open);
  $('r-toggle').setAttribute('aria-expanded', String(open));
  refreshBaseStatus();
  // load the generator's modules in the background so the first Generate is quick
  setTimeout(() => { try { getWorker(); } catch (e) {} }, 2000);
  kvGet('last-seed').then((v) => { if (v && v.rom) { last = v; showLast(); } }).catch(() => {});
}

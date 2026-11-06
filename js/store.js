// Dáta a synchronizácia.
// Hlavný zdroj pravdy je Supabase. IndexedDB slúži ako cache (rýchly štart, offline náhľad)
// a ako fronta neodoslaných zmien (outbox). Zmeny sa odosielajú idempotentnými RPC funkciami,
// server rozhoduje „posledná zmena vyhráva“ podľa client_updated_at (s opravou posunu hodín).
import { idb, tx } from './idb.js';
import { rest, storage, ApiError } from './api.js';
import { getUser, getSession } from './auth.js';
import { getConfig, SYNC_INTERVAL_MS, FULL_RECONCILE_MS } from './config.js';
import { defaultZones } from './geometry.js';

const COLS = 'id,tracking_number,location,x,y,sector,package_type,is_allegro,note,workspace_id,client_updated_at,server_updated_at,created_at';
const WS_COLS = 'id,name,photo_path,photo_hash,photo_width,photo_height,zones,client_updated_at,server_updated_at';
const OVERLAP_MS = 60_000;
const RELEASED_KEEP_MS = 3 * 24 * 3600 * 1000;
const BUCKET = 'regal-photos';

const parcels = new Map();
let workspace = null;           // { ...row, photoUrl }
let photoUrl = null;
let clockOffset = 0;            // serverTime - localTime (ms)
let offsetMeasuredAt = 0;
let status = { state: 'idle', lastSync: null, pending: 0, failed: [], message: '' };
const listeners = { change: new Set(), status: new Set(), notice: new Set() };
const dataChannel = 'BroadcastChannel' in self ? new BroadcastChannel('regal-data') : null;

export function on(evt, fn) { listeners[evt].add(fn); return () => listeners[evt].delete(fn); }
function emit(evt, payload) { for (const fn of listeners[evt]) { try { fn(payload); } catch (e) { console.error(e); } } }
function setStatus(patch) { status = { ...status, ...patch }; emit('status', status); }
function notifyOtherTabs() { dataChannel?.postMessage({ type: 'data', at: Date.now() }); }
function changed(info = {}) { emit('change', info); }

export const serverNow = () => new Date(Date.now() + clockOffset);
const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();
const t = (v) => (v ? new Date(v).getTime() : 0);

// ------------------------------------------------------------------ čítanie
export function getStatus() { return status; }
export function getParcel(n) { return parcels.get(n) || null; }
export function allParcels() {
  return [...parcels.values()].sort((a, b) => t(b.created_at || b.client_updated_at) - t(a.created_at || a.client_updated_at));
}
export function counts() {
  const c = { all: 0, table: 0, front: 0, shelf: 0, allegro: 0 };
  for (const p of parcels.values()) { c.all++; c[p.location] = (c[p.location] || 0) + 1; }
  return c;
}
export function getWorkspace() { return workspace; }
export function getPhotoUrl() { return photoUrl; }
export function getZones() { return workspace?.zones?.groups ? workspace.zones : defaultZones(); }

// ------------------------------------------------------------------ štart
export async function init() {
  await loadFromDb();
  const meta = await idb.get('meta', 'clock');
  if (meta) { clockOffset = meta.offset || 0; offsetMeasuredAt = meta.at || 0; }
  dataChannel?.addEventListener('message', async () => { await loadFromDb(); changed({ source: 'tab' }); });
  window.addEventListener('online', () => requestSync(0));
  window.addEventListener('offline', () => setStatus({ state: 'offline', message: 'Bez internetu – zmeny sa uložia a odošlú neskôr.' }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestSync(0); });
  window.addEventListener('focus', () => requestSync(0));
  setInterval(() => { if (document.visibilityState === 'visible') requestSync(0); }, SYNC_INTERVAL_MS);
}

async function loadFromDb() {
  const [rows, ws, outbox] = await Promise.all([idb.getAll('parcels'), idb.get('meta', 'workspace'), idb.getAll('outbox')]);
  parcels.clear();
  for (const r of rows) parcels.set(r.tracking_number, r);
  workspace = ws || null;
  await refreshPhotoUrl();
  updatePendingCount(outbox);
}

let photoUrlHash = null;
async function refreshPhotoUrl() {
  const hash = workspace?.photo_hash || null;
  if (photoUrl && photoUrlHash === hash) return;       // tá istá fotka – nič nenačítavame znova
  const blob = hash ? await idb.get('blobs', hash) : null;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = blob ? URL.createObjectURL(blob) : null;
  photoUrlHash = blob ? hash : null;
}
export function getPhotoHash() { return photoUrlHash; }

function updatePendingCount(outbox) {
  const failed = outbox.filter((o) => o.failed);
  setStatus({ pending: outbox.length - failed.length, failed });
}

// ------------------------------------------------------------------ outbox
async function enqueue(op) {
  await tx(['outbox'], 'readwrite', async (s, w) => {
    const all = await w(s.outbox.getAll());
    for (const o of all) {
      const sameParcel = op.number && o.number === op.number;
      if (op.type === 'upsert' && sameParcel && o.type === 'upsert') s.outbox.delete(o.seq);
      if (op.type === 'release' && sameParcel) s.outbox.delete(o.seq);
      if (op.type === 'workspace' && o.type === 'workspace') s.outbox.delete(o.seq);
    }
    s.outbox.add({ ...op, queued_at: Date.now(), attempts: 0 });
  });
  updatePendingCount(await idb.getAll('outbox'));
}

export async function discardFailed(seq) {
  await idb.del('outbox', seq);
  updatePendingCount(await idb.getAll('outbox'));
}
export async function retryFailed() {
  const all = await idb.getAll('outbox');
  await tx(['outbox'], 'readwrite', (s) => { for (const o of all) if (o.failed) s.outbox.put({ ...o, failed: false, error: null }); });
  updatePendingCount(await idb.getAll('outbox'));
  requestSync(0);
}

// ------------------------------------------------------------------ zmeny
function cleanRow(p) {
  return {
    id: p.id || crypto.randomUUID(),
    tracking_number: p.tracking_number,
    location: p.location,
    x: p.x == null ? null : Math.min(1, Math.max(0, Number(p.x))),
    y: p.y == null ? null : Math.min(1, Math.max(0, Number(p.y))),
    sector: p.location === 'shelf' ? p.sector : null,
    package_type: p.package_type === 'bag' ? 'bag' : 'box',   // predvolená „Krabica“ sa uloží vždy
    is_allegro: p.location === 'allegro',
    note: (p.note || '').trim().slice(0, 500) || null,
    workspace_id: workspace?.id || null,
  };
}

/** Uloží (pridá/upraví) zásielku lokálne a zaradí ju na odoslanie. */
export async function saveParcel(input) {
  const existing = parcels.get(input.tracking_number);
  const row = cleanRow({ ...existing, ...input });
  if (existing?.id) row.id = existing.id;
  let ts = serverNow();
  if (existing && t(existing.client_updated_at) >= ts.getTime()) ts = new Date(t(existing.client_updated_at) + 1);
  const rel = await idb.get('released', row.tracking_number);
  if (rel && t(rel.released_at) >= ts.getTime()) ts = new Date(t(rel.released_at) + 1);
  const local = {
    ...row,
    client_updated_at: iso(ts),
    created_at: existing?.created_at || iso(ts),
    server_updated_at: existing?.server_updated_at || null,
    _pending: true,
  };
  parcels.set(local.tracking_number, local);
  await tx(['parcels', 'released'], 'readwrite', (s) => { s.parcels.put(local); s.released.delete(local.tracking_number); });
  await enqueue({ type: 'upsert', number: local.tracking_number, payload: { ...row, client_updated_at: local.client_updated_at } });
  changed({ saved: local.tracking_number });
  notifyOtherTabs();
  requestSync(150);
  return local;
}

const releasing = new Set();
/** Vydá zásielku: hneď zmizne z mapy/zoznamu, server ju zmaže pri synchronizácii. */
export async function releaseParcel(number) {
  if (releasing.has(number)) return null;          // ochrana pred dvojitým stlačením
  const p = parcels.get(number);
  if (!p) return null;
  releasing.add(number);
  try {
    let ts = serverNow();
    if (t(p.client_updated_at) >= ts.getTime()) ts = new Date(t(p.client_updated_at) + 1);
    parcels.delete(number);
    await tx(['parcels', 'released'], 'readwrite', (s) => {
      s.parcels.delete(number);
      s.released.put({ tracking_number: number, released_at: iso(ts), at: Date.now() });
    });
    await enqueue({ type: 'release', number, released_at: iso(ts) });
    changed({ released: number });
    notifyOtherTabs();
    requestSync(0);
    return p;
  } finally {
    releasing.delete(number);
  }
}

// ------------------------------------------------------------------ pracovisko
export async function setWorkspaceZones(zones) {
  const ws = { ...(workspace || {}), zones, client_updated_at: iso(serverNow()) };
  workspace = ws;
  await idb.put('meta', ws, 'workspace');
  await enqueue({ type: 'workspace' });
  changed({ workspace: true });
  notifyOtherTabs();
  requestSync(0);
}

export async function setWorkspacePhoto(blob, width, height) {
  const user = getUser();
  if (!user) throw new Error('Na nahratie fotky sa musíš prihlásiť.');
  const hash = await sha256(blob);
  await idb.put('blobs', blob, hash);
  const ws = {
    ...(workspace || {}),
    photo_hash: hash,
    photo_path: `${user.id}/ws-${hash.slice(0, 32)}.jpg`,
    photo_width: width,
    photo_height: height,
    client_updated_at: iso(serverNow()),
  };
  const oldHash = workspace?.photo_hash;
  workspace = ws;
  await idb.put('meta', ws, 'workspace');
  if (oldHash && oldHash !== hash) idb.del('blobs', oldHash).catch(() => {});
  await refreshPhotoUrl();
  await enqueue({ type: 'photo', hash, path: ws.photo_path });
  await enqueue({ type: 'workspace' });
  changed({ workspace: true, photo: true });
  notifyOtherTabs();
  requestSync(0);
}

async function sha256(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ synchronizácia
let syncTimer = null;
let running = false;
let again = false;

export function requestSync(delay = 300) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

export async function syncNow({ full = false } = {}) {
  if (running) { again = true; return; }
  const { supabaseUrl } = getConfig();
  if (!supabaseUrl) { setStatus({ state: 'no_config', message: 'Nastav pripojenie k Supabase.' }); return; }
  if (!getSession()) { setStatus({ state: 'signed_out', message: 'Prihlás sa, aby sa zásielky synchronizovali.' }); return; }
  if (!navigator.onLine) { setStatus({ state: 'offline', message: 'Bez internetu – zmeny čakajú na odoslanie.' }); return; }
  running = true;
  setStatus({ state: 'syncing', message: 'Synchronizujem…' });
  const guard = new Promise((_, rej) => setTimeout(() => rej(new ApiError('Synchronizácia trvala príliš dlho.', { kind: 'timeout' })), 90_000));
  try {
    const work = async () => {
      await measureClock();
      await flushOutbox();
      await pull(full);
      await pullWorkspace();
    };
    // naprieč kartami beží naraz iba jedna synchronizácia
    const locked = navigator.locks?.request
      ? navigator.locks.request('regal-sync', { ifAvailable: true }, (lock) => (lock ? work() : 'busy'))
      : work();
    const r = await Promise.race([locked, guard]);
    if (r === 'busy') { await loadFromDb(); changed({ source: 'tab' }); }
    setStatus({ state: 'ok', lastSync: Date.now(), message: '' });
  } catch (e) {
    handleSyncError(e);
  } finally {
    running = false;
    updatePendingCount(await idb.getAll('outbox'));
    if (again) { again = false; requestSync(200); }
  }
}

function handleSyncError(e) {
  console.warn('sync', e);
  if (e.kind === 'auth') setStatus({ state: 'signed_out', message: e.message });
  else if (e.kind === 'network' || e.kind === 'timeout') setStatus({ state: navigator.onLine ? 'error' : 'offline', message: e.message, retryable: true });
  else setStatus({ state: 'error', message: e.message || 'Synchronizácia zlyhala.', retryable: true });
}

async function measureClock() {
  if (Date.now() - offsetMeasuredAt < 30 * 60 * 1000) return;
  const t0 = Date.now();
  const server = await rest.rpc('regal_server_time', {}, { retries: 1 });
  const t1 = Date.now();
  clockOffset = new Date(server).getTime() - (t0 + t1) / 2;
  offsetMeasuredAt = Date.now();
  await idb.put('meta', { offset: clockOffset, at: offsetMeasuredAt }, 'clock');
}

async function flushOutbox() {
  const ops = (await idb.getAll('outbox')).filter((o) => !o.failed).sort((a, b) => a.seq - b.seq);
  let touched = false;
  for (const op of ops) {
    try {
      if (op.type === 'upsert') touched = (await sendUpsert(op)) || touched;
      else if (op.type === 'release') touched = (await sendRelease(op)) || touched;
      else if (op.type === 'photo') await sendPhoto(op);
      else if (op.type === 'workspace') await sendWorkspace();
      await idb.del('outbox', op.seq);
    } catch (e) {
      if (e.transient || e.kind === 'auth' || e.kind === 'schema' || e.kind === 'config') throw e;
      // trvalá chyba jedného záznamu (napr. neplatné údaje) – neblokuje ostatné
      await idb.put('outbox', { ...op, failed: true, error: e.message, attempts: (op.attempts || 0) + 1 });
      emit('notice', { kind: 'error', text: `Zmenu ${op.number || ''} sa nepodarilo uložiť: ${e.message}` });
    }
  }
  await recomputePending();
  if (touched) { changed({ source: 'sync' }); notifyOtherTabs(); }
}

async function recomputePending() {
  const outbox = await idb.getAll('outbox');
  const pendingNums = new Set(outbox.filter((o) => o.type === 'upsert').map((o) => o.number));
  const updates = [];
  for (const p of parcels.values()) {
    const pend = pendingNums.has(p.tracking_number);
    if (Boolean(p._pending) !== pend) { p._pending = pend; updates.push(p); }
  }
  if (updates.length) await tx(['parcels'], 'readwrite', (s) => { for (const p of updates) s.parcels.put(p); });
}

async function applyServerRow(row) {
  const n = row.tracking_number;
  const local = parcels.get(n);
  const rel = await idb.get('released', n);
  if (rel && t(rel.released_at) >= t(row.client_updated_at)) return false;     // lokálne už vydaná
  if (local && local._pending && t(local.client_updated_at) > t(row.client_updated_at)) return false; // lokálne novšia
  if (local && !local._pending && local.client_updated_at === row.client_updated_at && local.server_updated_at === row.server_updated_at) return false;
  const merged = { ...row, _pending: false, _verified_at: Date.now() };
  parcels.set(n, merged);
  await idb.put('parcels', merged);
  return true;
}

async function applyTombstone(n, releasedAt) {
  const local = parcels.get(n);
  if (!local) return false;
  if (t(local.client_updated_at) > t(releasedAt)) return false; // lokálne znova pridaná neskôr
  parcels.delete(n);
  await idb.del('parcels', n);
  return true;
}

async function sendUpsert(op) {
  const res = await rest.rpc('regal_upsert_parcel', { p: op.payload });
  if (res.status === 'ok' || res.status === 'stale') {
    // „stale“ s rovnakým časom = naša zmena už prešla (napr. odpoveď sa stratila) – nie je to konflikt
    if (res.status === 'stale' && t(res.row?.client_updated_at) !== t(op.payload.client_updated_at)) {
      emit('notice', { kind: 'info', text: `Zásielku ${op.number} medzitým zmenilo iné zariadenie – platí novšia verzia.` });
    }
    return applyServerRow(res.row);
  }
  if (res.status === 'released') {
    emit('notice', { kind: 'info', text: `Zásielka ${op.number} už bola vydaná na inom zariadení.` });
    return applyTombstone(op.number, res.released_at);
  }
  return false;
}

async function sendRelease(op) {
  const res = await rest.rpc('regal_release_parcel', { p_tracking_number: op.number, p_released_at: op.released_at });
  if (res.status === 'newer_exists') {
    // niekto zásielku po vydaní znova pridal → načítame novšiu verziu
    const rows = await rest.select('regal_parcels', `select=${COLS}&tracking_number=eq.${encodeURIComponent(op.number)}`);
    await idb.del('released', op.number);
    if (rows[0]) { await applyServerRow(rows[0]); return true; }
  }
  return false;
}

async function sendPhoto(op) {
  const blob = await idb.get('blobs', op.hash);
  if (!blob) return; // fotka bola medzitým nahradená novšou
  await storage.upload(BUCKET, op.path, blob);
}

async function sendWorkspace() {
  const ws = workspace;
  if (!ws) return;
  const row = {
    name: ws.name || 'Pracovisko',
    photo_path: ws.photo_path || null,
    photo_hash: ws.photo_hash || null,
    photo_width: ws.photo_width || null,
    photo_height: ws.photo_height || null,
    zones: ws.zones || {},
    client_updated_at: ws.client_updated_at || iso(serverNow()),
  };
  const res = await rest.upsert('regal_workspaces', row, 'user_id');
  const saved = Array.isArray(res) ? res[0] : res;
  if (saved) {
    const oldPath = workspace?._server_photo_path;
    workspace = { ...workspace, id: saved.id, server_updated_at: saved.server_updated_at, _server_photo_path: saved.photo_path };
    await idb.put('meta', workspace, 'workspace');
    if (oldPath && oldPath !== saved.photo_path) storage.remove(BUCKET, [oldPath]).catch(() => {});
  }
}

async function selectAllPaged(table, query) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rest.select(table, `${query}&limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

async function pull(forceFull) {
  const startedAt = serverNow();
  const lastFull = (await idb.get('meta', 'lastFull')) || 0;
  const cursor = await idb.get('meta', 'cursor');
  let touched = false;

  if (forceFull || !cursor || Date.now() - lastFull > FULL_RECONCILE_MS) {
    const rows = await selectAllPaged('regal_parcels', `select=${COLS}&order=tracking_number.asc`);
    const serverNums = new Set(rows.map((r) => r.tracking_number));
    for (const r of rows) touched = (await applyServerRow(r)) || touched;
    // záznamy, ktoré na serveri už nie sú (vydané inde) a lokálne nečakajú na odoslanie
    for (const p of [...parcels.values()]) {
      if (!serverNums.has(p.tracking_number) && !p._pending) {
        parcels.delete(p.tracking_number);
        await idb.del('parcels', p.tracking_number);
        touched = true;
      }
    }
    await idb.put('meta', Date.now(), 'lastFull');
  } else {
    const since = encodeURIComponent(iso(t(cursor) - OVERLAP_MS));
    const [rows, released] = await Promise.all([
      rest.select('regal_parcels', `select=${COLS}&server_updated_at=gt.${since}&order=server_updated_at.asc&limit=5000`),
      rest.select('regal_released', `select=tracking_number,released_at&server_updated_at=gt.${since}&limit=5000`),
    ]);
    for (const r of rows) touched = (await applyServerRow(r)) || touched;
    for (const r of released) touched = (await applyTombstone(r.tracking_number, r.released_at)) || touched;
  }
  await idb.put('meta', iso(startedAt), 'cursor');
  await purgeOldReleased();
  if (touched) { changed({ source: 'sync' }); notifyOtherTabs(); }
}

async function purgeOldReleased() {
  const all = await idb.getAll('released');
  const old = all.filter((r) => Date.now() - (r.at || 0) > RELEASED_KEEP_MS);
  if (old.length) await tx(['released'], 'readwrite', (s) => { for (const r of old) s.released.delete(r.tracking_number); });
}

async function pullWorkspace() {
  const outbox = await idb.getAll('outbox');
  if (outbox.some((o) => o.type === 'workspace' || o.type === 'photo')) return; // lokálne zmeny ešte čakajú
  const rows = await rest.select('regal_workspaces', `select=${WS_COLS}&limit=1`);
  const row = rows[0];
  if (!row) return;
  const localNewer = workspace && t(workspace.client_updated_at) > t(row.client_updated_at);
  if (localNewer) return;
  const photoChanged = row.photo_hash && row.photo_hash !== workspace?.photo_hash;
  const haveBlob = row.photo_hash ? Boolean(await idb.get('blobs', row.photo_hash)) : true;
  const sameMeta = workspace && workspace.server_updated_at === row.server_updated_at;
  if (sameMeta && haveBlob) return;
  if (row.photo_hash && !haveBlob) {
    // fotku sťahujeme IBA keď sa zmenil jej hash (nie pri každej synchronizácii)
    const blob = await storage.download(BUCKET, row.photo_path);
    await idb.put('blobs', blob, row.photo_hash);
    if (workspace?.photo_hash && workspace.photo_hash !== row.photo_hash) idb.del('blobs', workspace.photo_hash).catch(() => {});
  }
  workspace = { ...row, _server_photo_path: row.photo_path };
  await idb.put('meta', workspace, 'workspace');
  await refreshPhotoUrl();
  changed({ workspace: true, photo: photoChanged });
  notifyOtherTabs();
}

/**
 * Overí jednu zásielku priamo v databáze (výsledok hľadania nesmie byť len z cache).
 * Vracia { state: 'verified'|'missing'|'offline'|'pending', parcel }
 */
export async function verifyParcel(number) {
  const local = parcels.get(number);
  if (!getSession()) return { state: 'unverified', parcel: local };
  if (!navigator.onLine) return { state: 'offline', parcel: local };
  try {
    const rows = await rest.select('regal_parcels', `select=${COLS}&tracking_number=eq.${encodeURIComponent(number)}`);
    const row = rows[0];
    if (row) {
      const was = parcels.get(number);
      const touched = await applyServerRow(row);
      if (touched) { changed({ source: 'verify' }); notifyOtherTabs(); }
      const now = parcels.get(number);
      return { state: now?._pending ? 'pending' : 'verified', parcel: now || was };
    }
    if (local?._pending) return { state: 'pending', parcel: local };
    if (local) {
      parcels.delete(number);
      await idb.del('parcels', number);
      changed({ source: 'verify' });
      notifyOtherTabs();
    }
    return { state: 'missing', parcel: null };
  } catch (e) {
    return { state: e.kind === 'auth' ? 'unverified' : 'offline', parcel: local, error: e };
  }
}

/** Po odhlásení necháme cache aj frontu – po prihlásení sa odošle. Úplné vymazanie len na žiadosť. */
export async function wipeLocalData() {
  await Promise.all(['parcels', 'outbox', 'meta', 'blobs', 'released'].map((s) => idb.clear(s)));
  parcels.clear();
  workspace = null;
  await refreshPhotoUrl();
  updatePendingCount([]);
  changed({ source: 'wipe' });
}

export async function exportJson() {
  return {
    app: 'regal', exported_at: new Date().toISOString(),
    parcels: allParcels().map(({ _pending, _verified_at, ...p }) => p),
  };
}

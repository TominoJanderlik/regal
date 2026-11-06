// Regál – rozšírenie: pozadie (service worker)
// • prihlásenie do Supabase (rovnaký účet ako v aplikácii Regál), obnova tokenu jedným spoločným volaním
// • vyhľadanie zásielky a rozloženia mapy, vydanie zásielky
// • zapnutie rozšírenia na konkrétnej stránke (napr. Balíkovo) – iba s výslovným povolením používateľa

const DEFAULTS = {
  supabaseUrl: 'https://pudvswjifctcskujrzlr.supabase.co',
  supabaseKey: 'sb_publishable_1uf5XK4NkDNF1OussTFXGA_pZQFwYkg',   // verejný (publishable) kľúč – dáta chránia pravidlá RLS
  appUrl: 'https://tominojanderlik.github.io/regal/',
};
const TIMEOUT_MS = 12000;
const COLS = 'tracking_number,location,x,y,sector,package_type,is_allegro,note,created_at,client_updated_at';

async function config() {
  const { config: c } = await chrome.storage.local.get('config');
  return { ...DEFAULTS, ...(c || {}) };
}

// ------------------------------------------------------------------ relácia
let refreshing = null;
const nowS = () => Math.floor(Date.now() / 1000);

async function getSession() { return (await chrome.storage.local.get('session')).session || null; }
async function setSession(s) { if (s) await chrome.storage.local.set({ session: s }); else await chrome.storage.local.remove('session'); }

async function authFetch(path, body) {
  const c = await config();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${c.supabaseUrl}/auth/v1/${path}`, {
      method: 'POST', headers: { apikey: c.supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error_description || data.msg || data.message || `Chyba ${res.status}`;
      const e = new Error(/invalid login/i.test(msg) ? 'Nesprávny e-mail alebo heslo.' : msg);
      e.status = res.status; e.rejected = res.status >= 400 && res.status < 500;
      throw e;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Server neodpovedal včas.'), { network: true });
    if (e instanceof TypeError) throw Object.assign(new Error('Bez pripojenia k internetu.'), { network: true });
    throw e;
  } finally { clearTimeout(t); }
}

function toSession(d) {
  return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || nowS() + (d.expires_in || 3600), email: d.user?.email };
}

async function refresh(failedToken) {
  const cur = await getSession();
  if (!cur) throw Object.assign(new Error('Nie si prihlásený.'), { auth: true });
  if (failedToken && cur.access_token !== failedToken && cur.expires_at - nowS() > 30) return cur;   // už obnovené
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const d = await authFetch('token?grant_type=refresh_token', { refresh_token: cur.refresh_token });
      const s = { ...toSession(d), email: d.user?.email || cur.email };
      await setSession(s);
      return s;
    } catch (e) {
      if (e.rejected) { await setSession(null); throw Object.assign(new Error('Prihlásenie vypršalo – prihlás sa znova v rozšírení.'), { auth: true }); }
      throw e;   // výpadok siete reláciu nemaže
    } finally { refreshing = null; }
  })();
  return refreshing;
}

async function token() {
  let s = await getSession();
  if (!s) throw Object.assign(new Error('Prihlás sa v rozšírení Regál (ikona vpravo hore).'), { auth: true });
  if (s.expires_at - nowS() < 60) s = await refresh(s.access_token);
  return s.access_token;
}

async function api(path, { method = 'GET', body } = {}) {
  const c = await config();
  for (let attempt = 0, retried401 = false; attempt < 3; attempt++) {
    const tok = await token();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${c.supabaseUrl}${path}`, {
        method, signal: ctrl.signal,
        headers: { apikey: c.supabaseKey, Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      clearTimeout(t);
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); continue; }
      throw Object.assign(new Error(e.name === 'AbortError' ? 'Server neodpovedal včas.' : 'Bez pripojenia k internetu.'), { network: true });
    }
    clearTimeout(t);
    if (res.status === 401 && !retried401) { retried401 = true; attempt--; await refresh(tok); continue; }
    if (res.status >= 500 && attempt < 2) { await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); continue; }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message || `Chyba servera ${res.status}`);
    return data;
  }
  throw new Error('Server je nedostupný.');
}

// ------------------------------------------------------------------ dáta
let zonesCache = { at: 0, zones: null };
async function zones() {
  if (zonesCache.zones && Date.now() - zonesCache.at < 5 * 60 * 1000) return zonesCache.zones;
  const rows = await api('/rest/v1/regal_workspaces?select=zones&limit=1');
  zonesCache = { at: Date.now(), zones: rows?.[0]?.zones || null };
  return zonesCache.zones;
}

async function lookup(number) {
  const [rows, z] = await Promise.all([
    api(`/rest/v1/regal_parcels?select=${COLS}&tracking_number=eq.${encodeURIComponent(number)}`),
    zones().catch(() => null),
  ]);
  return { parcel: rows?.[0] || null, zones: z };
}

async function release(number) {
  const res = await api('/rest/v1/rpc/regal_release_parcel', { method: 'POST', body: { p_tracking_number: number, p_released_at: new Date().toISOString() } });
  return res;
}

// ------------------------------------------------------------------ zapnutie na stránke
const scriptId = (origin) => `regal-${origin.replace(/[^a-z0-9]/gi, '_')}`;

async function enableSite(origin, tabId) {
  const id = scriptId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!existing.length) {
    await chrome.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: ['content.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true }]);
  }
  const { sites = [] } = await chrome.storage.local.get('sites');
  if (!sites.includes(origin)) await chrome.storage.local.set({ sites: [...sites, origin] });
  if (tabId) await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
}

async function disableSite(origin) {
  await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] }).catch(() => {});
  const { sites = [] } = await chrome.storage.local.get('sites');
  await chrome.storage.local.set({ sites: sites.filter((s) => s !== origin) });
  await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => {});
}

// ------------------------------------------------------------------ správy
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'lookup': return reply({ ok: true, ...(await lookup(msg.number)), appUrl: (await config()).appUrl });
        case 'release': return reply({ ok: true, result: await release(msg.number) });
        case 'restore': {
          const p = msg.parcel;
          const res = await api('/rest/v1/rpc/regal_upsert_parcel', { method: 'POST', body: { p: {
            tracking_number: p.tracking_number, location: p.location, x: p.x, y: p.y, sector: p.sector,
            package_type: p.package_type, is_allegro: p.is_allegro, note: p.note, client_updated_at: new Date().toISOString() } } });
          return reply({ ok: res?.status === 'ok', error: res?.status !== 'ok' ? 'Zásielku sa nepodarilo vrátiť.' : undefined });
        }
        case 'login': {
          const d = await authFetch('token?grant_type=password', { email: msg.email, password: msg.password });
          await setSession(toSession(d));
          zonesCache = { at: 0, zones: null };
          return reply({ ok: true, email: d.user?.email });
        }
        case 'logout': await setSession(null); return reply({ ok: true });
        case 'status': {
          const s = await getSession();
          const { sites = [] } = await chrome.storage.local.get('sites');
          return reply({ ok: true, email: s?.email || null, sites });
        }
        case 'enableSite': await enableSite(msg.origin, msg.tabId); return reply({ ok: true });
        case 'disableSite': await disableSite(msg.origin); return reply({ ok: true });
        default: return reply({ ok: false, error: 'Neznáma požiadavka' });
      }
    } catch (e) {
      reply({ ok: false, error: e.message, auth: Boolean(e.auth), network: Boolean(e.network) });
    }
  })();
  return true;   // odpoveď príde asynchrónne
});
